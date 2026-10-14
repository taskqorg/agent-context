// Test-only native runner / RTK process double for the §3 capture and fallback chain.
use std::{
    io::Write,
    process::{Command, exit},
};
fn main() {
    let exe = std::env::current_exe().unwrap();
    if exe.file_stem().unwrap() == "rtk" {
        let args: Vec<_> = std::env::args().skip(1).collect();
        let mut c = Command::new(&args[0]);
        c.args(&args[1..]);
        if std::env::var("FILTER").as_deref() == Ok("changed_args") {
            c.arg("--unrequested");
        }
        let o = c.output().unwrap();
        match std::env::var("FILTER").as_deref() {
            Ok("timeout") => std::thread::sleep(std::time::Duration::from_secs(10)),
            Ok("error") => exit(99),
            Ok("not_smaller") => {
                std::io::stdout().write_all(&o.stdout).unwrap();
            }
            _ => println!("test summary: all original cases accounted for"),
        }
        exit(o.status.code().unwrap_or(1));
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::var_os("CALLS").unwrap())
        .unwrap();
    writeln!(f, "native call").unwrap();
    print!(
        "{}",
        std::env::var("TEXT")
            .unwrap_or_else(|_| "test result with preserved details\n".repeat(100))
    );
    eprint!("native stderr\n");
    exit(
        std::env::var("EXIT")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0),
    );
}
