use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    process::{Child, Command},
    time::{SystemTime, UNIX_EPOCH},
};

fn start(root: &Path, request: Value) -> Child {
    Command::new(env!("CARGO_BIN_EXE_herdr-pr"))
        .args([
            "--state",
            root.to_str().unwrap(),
            "--json",
            &request.to_string(),
        ])
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap()
}

fn finish(child: Child) -> Value {
    let result = child.wait_with_output().unwrap();
    assert!(result.status.success());
    let result: Value = serde_json::from_slice(&result.stdout).unwrap();
    assert_eq!(result["ok"], true, "{result}");
    result["data"].clone()
}

#[test]
fn roles_merge_owned_fields_without_losing_each_others_drafts() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("herdr-pr-draft-{}-{nonce}", std::process::id()));
    finish(start(
        &root,
        json!({"op":"draft.save","key":"comparison","draft":{"body":"Original summary","event":"COMMENT"}}),
    ));
    let notes = start(
        &root,
        json!({"op":"draft.save","key":"comparison","draft":{
            "notes":[{"body":"Keep this line note"}],"threads":[{"path":"a.rs","line":3,"side":"RIGHT","body":"Keep this line note"}],
            "inlineDrafts":{"a.rs":{"body":"Unfinished"}}
        }}),
    );
    let summary = start(
        &root,
        json!({"op":"draft.save","key":"comparison","draft":{"body":"Edited in composer","event":"APPROVE"}}),
    );
    finish(notes);
    finish(summary);
    let saved = finish(start(&root, json!({"op":"draft.get","key":"comparison"})));
    assert_eq!(saved["draft"]["body"], "Edited in composer");
    assert_eq!(saved["draft"]["event"], "APPROVE");
    assert_eq!(saved["draft"]["notes"][0]["body"], "Keep this line note");
    assert_eq!(saved["draft"]["threads"][0]["line"], 3);
    assert_eq!(saved["draft"]["inlineDrafts"]["a.rs"]["body"], "Unfinished");
    finish(start(
        &root,
        json!({"op":"draft.save","key":"comparison","draft":{"body":"","notes":[],"threads":[]}}),
    ));
    let cleared = finish(start(&root, json!({"op":"draft.get","key":"comparison"})));
    assert_eq!(cleared["draft"]["body"], "");
    assert_eq!(cleared["draft"]["notes"], json!([]));
    assert_eq!(cleared["draft"]["threads"], json!([]));
    assert_eq!(cleared["draft"]["event"], "APPROVE");
    assert_eq!(
        cleared["draft"]["inlineDrafts"]["a.rs"]["body"],
        "Unfinished"
    );
    fs::remove_dir_all(root).unwrap();
}
