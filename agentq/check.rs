//! Explicit live qualification; offline selftest never starts a client or makes a model call.
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
const SOURCE: &str = include_str!("../scripts/check-client-compression.py");

fn python(install: &Path) -> Result<(PathBuf, Vec<&'static str>), String> {
    let mut candidates = vec![];
    if let Some(p) = crate::engines::headroom_exe(install) {
        candidates.push((
            p.with_file_name(format!("python{}", std::env::consts::EXE_SUFFIX)),
            vec![],
        ));
    }
    for name in ["python3", "python"] {
        candidates.push((PathBuf::from(name), vec![]));
    }
    if cfg!(windows) {
        candidates.push((PathBuf::from("py"), vec!["-3"]));
    }
    for (bin, args) in candidates {
        if coreq::quiet(
            Command::new(&bin)
                .args(&args)
                .args([
                    "-I",
                    "-X",
                    "utf8",
                    "-c",
                    "import sys; assert sys.version_info >= (3,9)",
                ])
                .current_dir(std::env::temp_dir())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        )
        .status()
        .is_ok_and(|s| s.success())
        {
            return Ok((bin, args));
        }
    }
    Err("live check needs Python 3.9+ or the installed Headroom runtime".into())
}

pub fn run(install: &Path, args: &[&str]) -> Result<i32, String> {
    let (bin, prefix) = python(install)?;
    let mut command = Command::new(bin);
    command
        .args(prefix)
        .args(["-I", "-X", "utf8", "-c", SOURCE]);
    if args.first().is_none_or(|s| s.starts_with('-')) {
        command.arg("both");
    }
    command
        .arg("--install")
        .arg(install)
        .args(args)
        .current_dir(std::env::temp_dir());
    coreq::quiet(&mut command)
        .status()
        .map(|s| s.code().unwrap_or(1))
        .map_err(|e| format!("live check: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_source_fits_native_windows_command_line() {
        let units = SOURCE.encode_utf16().count()
            + SOURCE.chars().filter(|c| *c == '"' || *c == '\\').count();
        assert!(
            units < 28_000,
            "leave space for executable, fixture and install paths below CreateProcess's 32767 limit"
        );
        assert!(SOURCE.contains("stats', '--records"));
    }
}
