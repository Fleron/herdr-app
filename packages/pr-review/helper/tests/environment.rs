use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

fn git(path: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}

#[test]
fn inherited_repository_controls_cannot_redirect_owned_checkout_operations() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("herdr-pr-env-{}-{nonce}", std::process::id()));
    let source = root.join("source");
    fs::create_dir_all(&source).unwrap();
    git(&source, &["init", "-b", "main"]);
    git(&source, &["config", "user.name", "Integration"]);
    git(&source, &["config", "user.email", "test@example.invalid"]);
    git(&source, &["config", "commit.gpgsign", "false"]);
    fs::write(source.join("tracked"), "base\n").unwrap();
    git(&source, &["add", "."]);
    git(&source, &["commit", "-m", "base"]);
    let base = git(&source, &["rev-parse", "HEAD"]);
    git(&source, &["switch", "-c", "feature"]);
    fs::write(source.join("newfile"), "feature\n").unwrap();
    git(&source, &["add", "."]);
    git(&source, &["commit", "-m", "feature"]);
    let head = git(&source, &["rev-parse", "HEAD"]);
    git(&source, &["switch", "main"]);
    let index = fs::read(source.join(".git/index")).unwrap();
    for variant in 0..3 {
        let request = json!({"op":"git.prepare", "repo":{
            "host":"github.com", "owner":"Example", "name":"Environment", "localPath":source,
            "fetchUrl":source, "url":"https://github.com/Example/Environment"
        }, "pr":{"number":1,"base":"main","head":"feature","baseOid":base,"headOid":head}});
        let mut child = Command::new(env!("CARGO_BIN_EXE_herdr-pr"));
        child.args([
            "--state",
            root.join(format!("state-{variant}")).to_str().unwrap(),
            "--json",
            &request.to_string(),
        ]);
        child.env("GIT_CONFIG_GLOBAL", "/dev/null");
        match variant {
            0 => {
                child.env("GIT_INDEX_FILE", source.join(".git/index"));
            }
            1 => {
                child
                    .env("GIT_DIR", source.join(".git"))
                    .env("GIT_WORK_TREE", &source);
            }
            _ => {
                child
                    .env("GIT_COMMON_DIR", source.join(".git"))
                    .env("GIT_OBJECT_DIRECTORY", source.join(".git/objects"))
                    .env("GIT_CONFIG_COUNT", "1")
                    .env("GIT_CONFIG_KEY_0", "core.worktree")
                    .env("GIT_CONFIG_VALUE_0", &source);
            }
        }
        let output = child.output().unwrap();
        assert!(output.status.success());
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(fs::read(source.join(".git/index")).unwrap(), index);
        assert_eq!(git(&source, &["rev-parse", "HEAD"]), base);
        assert_eq!(
            fs::read_to_string(source.join("tracked")).unwrap(),
            "base\n"
        );
        assert!(!source.join("newfile").exists());
        assert!(git(&source, &["status", "--porcelain"]).is_empty());
    }
    fs::remove_dir_all(root).unwrap();
}
