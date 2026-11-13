-- コメント認証の穴をふさぐ（1回だけ実行）。すでにある表に、列を足す。
-- 更新前に発行された未使用のコード（verifier なし）は、使えなくなるので、消す。
ALTER TABLE auth_challenges ADD COLUMN verifier TEXT;
DELETE FROM auth_challenges;
