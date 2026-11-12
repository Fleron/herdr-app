use herdr_pr::{Context, git};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Fixture {
    root: PathBuf,
    source: PathBuf,
    ctx: Context,
    base: String,
    head: String,
}

fn command(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

impl Fixture {
    fn new() -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "herdr-pr-git-{}-{unique}-{}",
            std::process::id(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let source = root.join("source");
        fs::create_dir_all(&source).unwrap();
        command(&source, &["init", "-b", "main"]);
        command(&source, &["config", "user.name", "Git integration test"]);
        command(&source, &["config", "user.email", "test@example.invalid"]);
        command(&source, &["config", "commit.gpgsign", "false"]);
        fs::write(
            source.join("tracked.txt"),
            "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n",
        )
        .unwrap();
        fs::write(
            source.join("rename old.txt"),
            "rename me without changing the content\n",
        )
        .unwrap();
        fs::write(source.join("deleted.txt"), "deleted\n").unwrap();
        fs::write(source.join("binary.bin"), [0, 1, 2]).unwrap();
        fs::write(source.join(".gitignore"), "ignored.txt\n").unwrap();
        command(&source, &["add", "."]);
        command(&source, &["commit", "-m", "base"]);
        let base = command(&source, &["rev-parse", "HEAD"]);
        command(&source, &["switch", "-c", "feature"]);
        fs::write(
            source.join("tracked.txt"),
            "one\ntwo changed\nthree\nfour\nfive\nsix\nseven\neight\n",
        )
        .unwrap();
        fs::rename(
            source.join("rename old.txt"),
            source.join("renamed\tfile\n.rs"),
        )
        .unwrap();
        fs::remove_file(source.join("deleted.txt")).unwrap();
        fs::write(source.join("-special[1].txt"), "special content\n").unwrap();
        fs::write(source.join("binary.bin"), [0, 9, 8]).unwrap();
        fs::write(
            source.join("large.txt"),
            (1..=350)
                .map(|n| format!("added {n}\n"))
                .collect::<String>(),
        )
        .unwrap();
        command(&source, &["add", "-A"]);
        command(&source, &["commit", "-m", "feature"]);
        let head = command(&source, &["rev-parse", "HEAD"]);
        command(&source, &["switch", "main"]);
        Self {
            ctx: Context {
                root: root.join("state"),
            },
            root,
            source,
            base,
            head,
        }
    }

    fn request(&self, op: &str) -> Value {
        json!({"op":op,"repo":{"host":"github.com","owner":"Example","name":"Test",
            "nameWithOwner":"Example/Test","key":"github.com/example/test","localPath":self.source,
            "fetchUrl":self.source,"url":"https://github.com/Example/Test"},
            "pr":{"number":9,"base":"main","head":"feature","baseOid":self.base,"headOid":self.head}})
    }

    fn call(&self, request: Value) -> herdr_pr::Result<Value> {
        git::handle(&self.ctx, &request).expect("recognized Git operation")
    }

    fn prepare(&self) -> Value {
        self.call(self.request("git.prepare")).unwrap()
    }

    fn advance(&mut self, ignored_collision: bool) {
        command(&self.source, &["switch", "feature"]);
        fs::write(self.source.join("tracked.txt"), "next feature revision\n").unwrap();
        command(&self.source, &["add", "tracked.txt"]);
        if ignored_collision {
            fs::write(self.source.join("ignored.txt"), "new tracked content\n").unwrap();
            command(&self.source, &["add", "-f", "ignored.txt"]);
        }
        command(&self.source, &["commit", "-m", "advance"]);
        self.head = command(&self.source, &["rev-parse", "HEAD"]);
        command(&self.source, &["switch", "main"]);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn collect(fixture: &Fixture, mut request: Value, field: &str) -> Vec<Value> {
    let mut out = Vec::new();
    loop {
        let result = fixture.call(request.clone()).unwrap();
        out.extend(result[field].as_array().unwrap().clone());
        if result["nextCursor"].is_null() {
            break;
        }
        request["cursor"] = result["nextCursor"].clone();
    }
    out
}

#[test]
fn pinned_diff_preserves_paths_binary_rename_and_all_pages() {
    let fixture = Fixture::new();
    let prepared = fixture.prepare();
    let target = &prepared["target"];
    assert_eq!(target["headOid"], fixture.head);
    assert_eq!(target["mergeBase"], fixture.base);
    let files = collect(&fixture, json!({"op":"git.files","target":target}), "files");
    assert_eq!(files.len(), 6);
    let renamed = files
        .iter()
        .find(|file| file["path"] == "renamed\tfile\n.rs")
        .unwrap();
    assert_eq!(renamed["oldPath"], "rename old.txt");
    assert_eq!(renamed["status"], "R");
    assert!(
        files
            .iter()
            .any(|file| file["path"] == "deleted.txt" && file["status"] == "D")
    );
    assert!(
        files
            .iter()
            .any(|file| file["path"] == "binary.bin" && file["binary"] == true)
    );
    let checkout = PathBuf::from(target["checkout"].as_str().unwrap());
    fs::write(
        checkout.join("tracked.txt"),
        "local work must not leak into PR diff\n",
    )
    .unwrap();
    let rows = collect(
        &fixture,
        json!({"op":"git.diff","target":target,"file":"tracked.txt"}),
        "rows",
    );
    assert!(
        rows.iter()
            .any(|row| row["kind"] == "+" && row["text"] == "two changed" && row["next"] == 2)
    );
    assert!(
        !rows
            .iter()
            .any(|row| row["text"].as_str().unwrap().contains("local work"))
    );
    let special = collect(
        &fixture,
        json!({"op":"git.diff","target":target,"file":"-special[1].txt"}),
        "rows",
    );
    assert!(special.iter().any(|row| row["text"] == "special content"));
    let large = collect(
        &fixture,
        json!({"op":"git.diff","target":target,"file":"large.txt"}),
        "rows",
    );
    assert_eq!(large.iter().filter(|row| row["kind"] == "+").count(), 350);
    assert!(
        large
            .iter()
            .any(|row| row["next"] == 350 && row["text"] == "added 350")
    );
    assert_eq!(
        command(&fixture.source, &["rev-parse", "HEAD"]),
        fixture.base
    );
    assert_eq!(
        command(&fixture.source, &["branch", "--show-current"]),
        "main"
    );
    assert!(!fixture.source.join(".git/FETCH_HEAD").exists());
}

#[test]
fn reopening_keeps_pinned_checkout_and_refuses_dirty_or_switched_updates() {
    let mut fixture = Fixture::new();
    let prepared = fixture.prepare();
    let old = prepared["target"].clone();
    let checkout = PathBuf::from(old["checkout"].as_str().unwrap());
    fixture.advance(false);
    let reopened = fixture.prepare();
    assert_eq!(reopened["target"]["key"], old["key"]);
    assert_eq!(reopened["updateAvailable"], true);
    assert_eq!(
        command(&checkout, &["rev-parse", "HEAD"]),
        old["headOid"].as_str().unwrap()
    );
    fs::write(checkout.join("tracked.txt"), "keep this work\n").unwrap();
    assert_eq!(
        fixture
            .call(fixture.request("git.update"))
            .unwrap_err()
            .code,
        "DIRTY_CHECKOUT"
    );
    assert_eq!(
        fs::read_to_string(checkout.join("tracked.txt")).unwrap(),
        "keep this work\n"
    );
    command(&checkout, &["checkout", "--", "tracked.txt"]);
    fs::write(checkout.join("untracked.txt"), "also keep this\n").unwrap();
    assert_eq!(
        fixture
            .call(fixture.request("git.update"))
            .unwrap_err()
            .code,
        "DIRTY_CHECKOUT"
    );
    fs::remove_file(checkout.join("untracked.txt")).unwrap();
    command(&checkout, &["switch", "-c", "personal-work"]);
    let status = fixture
        .call(json!({"op":"git.status","target":old}))
        .unwrap();
    assert_eq!(status["owned"], true);
    assert_eq!(status["matchesPinned"], false);
    assert_eq!(
        fixture
            .call(fixture.request("git.update"))
            .unwrap_err()
            .code,
        "OWNERSHIP_MISMATCH"
    );
    assert_eq!(
        command(&checkout, &["branch", "--show-current"]),
        "personal-work"
    );
}

#[test]
fn ignored_conflicting_files_survive_update() {
    let mut fixture = Fixture::new();
    let old = fixture.prepare()["target"].clone();
    let checkout = PathBuf::from(old["checkout"].as_str().unwrap());
    fs::write(checkout.join("ignored.txt"), "ignored local artifact\n").unwrap();
    fixture.advance(true);
    assert!(fixture.call(fixture.request("git.update")).is_err());
    assert_eq!(
        fs::read_to_string(checkout.join("ignored.txt")).unwrap(),
        "ignored local artifact\n"
    );
    assert_eq!(
        command(&checkout, &["rev-parse", "HEAD"]),
        old["headOid"].as_str().unwrap()
    );
}

#[test]
fn clean_update_advances_only_owned_checkout() {
    let mut fixture = Fixture::new();
    let old = fixture.prepare()["target"].clone();
    fixture.advance(false);
    let updated = fixture.call(fixture.request("git.update")).unwrap();
    let checkout = PathBuf::from(updated["target"]["checkout"].as_str().unwrap());
    assert_eq!(updated["target"]["headOid"], fixture.head);
    assert_ne!(updated["target"]["key"], old["key"]);
    assert_eq!(command(&checkout, &["rev-parse", "HEAD"]), fixture.head);
    assert_eq!(
        command(&fixture.source, &["rev-parse", "HEAD"]),
        fixture.base
    );
    let stale = fixture
        .call(json!({"op":"git.files","target":old}))
        .unwrap_err();
    assert_eq!(stale.code, "STALE_TARGET");
}

#[test]
fn owned_object_cache_computes_merge_base_even_with_shallow_source() {
    let mut fixture = Fixture::new();
    fs::write(
        fixture.source.join("main-only.txt"),
        "main advanced independently\n",
    )
    .unwrap();
    command(&fixture.source, &["add", "."]);
    command(&fixture.source, &["commit", "-m", "main advance"]);
    let ancestor = fixture.base.clone();
    fixture.base = command(&fixture.source, &["rev-parse", "HEAD"]);
    let shallow = fixture.root.join("shallow");
    command(
        &fixture.root,
        &[
            "clone",
            "--depth=1",
            "--single-branch",
            &format!("file://{}", fixture.source.display()),
            shallow.to_str().unwrap(),
        ],
    );
    assert_eq!(
        command(&shallow, &["rev-parse", "--is-shallow-repository"]),
        "true"
    );
    let mut request = fixture.request("git.prepare");
    request["repo"]["localPath"] = json!(shallow);
    let prepared = fixture.call(request).unwrap();
    assert_eq!(prepared["target"]["mergeBase"], ancestor);
    let files = collect(
        &fixture,
        json!({"op":"git.files","target":prepared["target"]}),
        "files",
    );
    assert!(!files.iter().any(|file| file["path"] == "main-only.txt"));
    assert_eq!(
        command(&shallow, &["rev-parse", "--is-shallow-repository"]),
        "true"
    );
}

#[test]
fn replaced_checkout_directory_is_never_adopted_or_updated() {
    let mut fixture = Fixture::new();
    let target = fixture.prepare()["target"].clone();
    let checkout = PathBuf::from(target["checkout"].as_str().unwrap());
    fs::rename(&checkout, fixture.root.join("saved-checkout")).unwrap();
    fs::create_dir(&checkout).unwrap();
    command(&checkout, &["init", "-b", "foreign"]);
    command(&checkout, &["config", "user.name", "Different checkout"]);
    command(
        &checkout,
        &["config", "user.email", "different@example.invalid"],
    );
    command(&checkout, &["config", "commit.gpgsign", "false"]);
    fs::write(checkout.join("keep.txt"), "belongs to another checkout\n").unwrap();
    command(&checkout, &["add", "."]);
    command(&checkout, &["commit", "-m", "unrelated"]);
    let foreign_head = command(&checkout, &["rev-parse", "HEAD"]);
    fixture.advance(false);
    let reopened = fixture.prepare();
    assert_eq!(reopened["checkoutStatus"]["owned"], false);
    assert_eq!(reopened["checkoutStatus"]["matchesPinned"], false);
    assert_eq!(
        fixture
            .call(fixture.request("git.update"))
            .unwrap_err()
            .code,
        "OWNERSHIP_MISMATCH"
    );
    assert_eq!(command(&checkout, &["rev-parse", "HEAD"]), foreign_head);
    assert_eq!(
        fs::read_to_string(checkout.join("keep.txt")).unwrap(),
        "belongs to another checkout\n"
    );
}

#[test]
fn oversized_single_line_is_reported_instead_of_partially_displayed() {
    let mut fixture = Fixture::new();
    command(&fixture.source, &["switch", "feature"]);
    fs::write(
        fixture.source.join("huge-line.txt"),
        format!("{}\n", "x".repeat(600_000)),
    )
    .unwrap();
    command(&fixture.source, &["add", "."]);
    command(&fixture.source, &["commit", "-m", "large row"]);
    fixture.head = command(&fixture.source, &["rev-parse", "HEAD"]);
    command(&fixture.source, &["switch", "main"]);
    let target = fixture.prepare()["target"].clone();
    let files = collect(&fixture, json!({"op":"git.files","target":target}), "files");
    assert!(files.iter().any(|file| file["path"] == "huge-line.txt"));
    let error = fixture
        .call(json!({"op":"git.diff","target":target,"file":"huge-line.txt"}))
        .unwrap_err();
    assert_eq!(error.code, "DIFF_LINE_TOO_LARGE");
}

#[cfg(unix)]
#[test]
fn file_type_changes_keep_both_patch_sections() {
    let mut fixture = Fixture::new();
    command(&fixture.source, &["switch", "feature"]);
    fs::remove_file(fixture.source.join("tracked.txt")).unwrap();
    std::os::unix::fs::symlink("elsewhere", fixture.source.join("tracked.txt")).unwrap();
    command(&fixture.source, &["add", "."]);
    command(&fixture.source, &["commit", "-m", "change file type"]);
    fixture.head = command(&fixture.source, &["rev-parse", "HEAD"]);
    command(&fixture.source, &["switch", "main"]);
    let target = fixture.prepare()["target"].clone();
    let files = collect(&fixture, json!({"op":"git.files","target":target}), "files");
    let changed = files
        .iter()
        .find(|file| file["path"] == "tracked.txt")
        .unwrap();
    assert_eq!(changed["status"], "T");
    assert_eq!(changed["oldMode"], "100644");
    assert_eq!(changed["newMode"], "120000");
    let rows = collect(
        &fixture,
        json!({"op":"git.diff","target":target,"file":"tracked.txt"}),
        "rows",
    );
    assert!(
        rows.iter()
            .any(|row| row["kind"] == "-" && row["text"] == "one")
    );
    assert!(
        rows.iter()
            .any(|row| row["kind"] == "+" && row["text"] == "elsewhere")
    );
}

#[test]
fn renamed_file_diff_excludes_new_children_of_its_old_path_and_old_cached_rows() {
    let mut fixture = Fixture::new();
    command(&fixture.source, &["switch", "feature"]);
    fs::create_dir(fixture.source.join("rename old.txt")).unwrap();
    fs::write(
        fixture.source.join("rename old.txt/extra"),
        "unrelated directory child\n",
    )
    .unwrap();
    fs::write(
        fixture.source.join("rename old.txt/huge"),
        format!("{}\n", "x".repeat(600_000)),
    )
    .unwrap();
    fs::write(
        fixture.source.join("rename old.txt/non-utf8"),
        [b'x', 255, b'\n'],
    )
    .unwrap();
    fs::write(
        fixture.source.join("renamed\tfile\n.rs"),
        "rename me without changing the content\nadded after renaming\n",
    )
    .unwrap();
    fs::write(
        fixture.source.join("quoted\"\\é.txt"),
        "quoted filename content\n",
    )
    .unwrap();
    command(&fixture.source, &["add", "."]);
    command(
        &fixture.source,
        &["commit", "-m", "rename source became a directory"],
    );
    fixture.head = command(&fixture.source, &["rev-parse", "HEAD"]);
    command(&fixture.source, &["switch", "main"]);
    let target = fixture.prepare()["target"].clone();
    let files = collect(&fixture, json!({"op":"git.files","target":target}), "files");
    assert!(files.iter().any(|file| file["path"] == "renamed\tfile\n.rs"
        && file["status"] == "R"
        && file["oldPath"] == "rename old.txt"));
    assert!(
        files
            .iter()
            .any(|file| file["path"] == "rename old.txt/extra" && file["status"] == "A")
    );
    let cache = fixture
        .ctx
        .root
        .join("git/diffs")
        .join(herdr_pr::digest(target["key"].as_str().unwrap()));
    fs::write(
        cache.join(format!("{}.jsonl", herdr_pr::digest("renamed\tfile\n.rs"))),
        "{\"kind\":\"+\",\"old\":null,\"next\":99,\"text\":\"stale unrelated content\"}\n",
    )
    .unwrap();
    let rows = collect(
        &fixture,
        json!({"op":"git.diff","target":target,"file":"renamed\tfile\n.rs"}),
        "rows",
    );
    assert!(rows.iter().any(|row| row["kind"] == "+"
        && row["text"] == "added after renaming"
        && row["next"] == 2));
    assert!(
        !rows
            .iter()
            .any(|row| row["text"].as_str().unwrap().contains("unrelated"))
    );
    let quoted = collect(
        &fixture,
        json!({"op":"git.diff","target":target,"file":"quoted\"\\é.txt"}),
        "rows",
    );
    assert!(
        quoted
            .iter()
            .any(|row| row["kind"] == "+" && row["text"] == "quoted filename content")
    );
}
