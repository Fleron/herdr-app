use herdr_pr::{Context, Error, Result, dispatch};
use serde_json::{Value, json};
use std::{fs, io::Read, path::PathBuf};

fn request() -> Result<(Context, Value)> {
    let mut args = std::env::args().skip(1);
    let mut root = None;
    let mut body = None;
    let mut input_path = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--state" => root = args.next().map(PathBuf::from),
            "--request" => {
                let path = args
                    .next()
                    .ok_or_else(|| Error::new("ARGUMENT", "--request needs a file"))?;
                let mut bytes = Vec::new();
                fs::File::open(&path)?
                    .take(8 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)?;
                body = Some(bytes);
                input_path = Some(PathBuf::from(path));
            }
            "--json" => body = args.next().map(String::into_bytes),
            _ => return Err(Error::new("ARGUMENT", format!("Unknown argument: {arg}"))),
        }
    }
    let root = root.ok_or_else(|| Error::new("ARGUMENT", "--state needs a directory"))?;
    let body = body.ok_or_else(|| Error::new("ARGUMENT", "Pass --request FILE or --json JSON"))?;
    if body.len() > 8 * 1024 * 1024 {
        return Err(Error::new(
            "REQUEST_TOO_LARGE",
            "Request exceeds the per-request byte budget",
        ));
    }
    let value = serde_json::from_slice(&body)?;
    if let Some(path) = input_path {
        let parent = path.parent().and_then(|p| p.canonicalize().ok());
        if parent.is_some() && parent == root.join("requests").canonicalize().ok() {
            fs::remove_file(path)?;
        }
    }
    Ok((Context { root }, value))
}

fn main() {
    let result = request().and_then(|(ctx, body)| dispatch(&ctx, &body));
    let response = match result {
        Ok(data) => json!({"ok":true,"data":data}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    let mut output = serde_json::to_vec(&response).unwrap();
    // The Herdr bridge captures 8 MiB without flagging truncation.
    if output.len() > 4 * 1024 * 1024 {
        output = serde_json::to_vec(&json!({"ok":false,"error":{
            "code":"REPLY_TOO_LARGE","message":"This page exceeds the reply byte budget. No partial result was returned."
        }})).unwrap();
    }
    println!("{}", String::from_utf8(output).unwrap());
}
