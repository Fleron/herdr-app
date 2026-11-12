use herdr_pr::{Context, run};
use serde_json::json;
use std::{
    fs,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[test]
fn inherited_environment_and_explicit_arguments_survive() {
    let output = run("/usr/bin/env", &[], None, Duration::from_secs(5)).unwrap();
    assert_eq!(output.code, 0);
    assert!(output.stdout.lines().any(|line| line.starts_with("HOME=")));
    let output = run(
        "/usr/bin/printf",
        &["%s".into(), "a b; $(no-execution)\n雪".into()],
        None,
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(output.stdout, "a b; $(no-execution)\n雪");
}

#[test]
fn deadline_also_covers_descendants_holding_output_open() {
    let start = Instant::now();
    let error = run(
        "/bin/sh",
        &["-c".into(), "sleep 5 &".into()],
        None,
        Duration::from_millis(100),
    )
    .unwrap_err();
    assert_eq!(error.code, "TIMEOUT");
    assert!(start.elapsed() < Duration::from_secs(3));
}

#[test]
fn overflowing_output_is_an_error_not_a_successful_prefix() {
    let error = run("/usr/bin/yes", &[], None, Duration::from_secs(10)).unwrap_err();
    assert_eq!(error.code, "OUTPUT_LIMIT");
}

#[test]
fn durable_state_roundtrips_under_a_keyed_lock() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("herdr-pr-state-{}-{nonce}", std::process::id()));
    let ctx = Context { root: root.clone() };
    let _lock = ctx.lock("review", "github.com/org/repo#142").unwrap();
    assert!(ctx.read("drafts", "pr142").unwrap().is_none());
    ctx.write(
        "drafts",
        "pr142",
        &json!({"body":"line one\nline two", "head":"abc"}),
    )
    .unwrap();
    let reopened = Context { root: root.clone() };
    assert_eq!(
        reopened.read("drafts", "pr142").unwrap().unwrap()["body"],
        "line one\nline two"
    );
    fs::remove_dir_all(root).unwrap();
}
