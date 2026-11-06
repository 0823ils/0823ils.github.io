use futures::stream::{self, StreamExt};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
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

#[tokio::main]
async fn main() {
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
