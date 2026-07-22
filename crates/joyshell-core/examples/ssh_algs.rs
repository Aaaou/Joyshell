use ssh2::{MethodType, Session};

fn main() -> anyhow::Result<()> {
    let session = Session::new()?;
    for method in [
        ("kex", MethodType::Kex),
        ("hostkey", MethodType::HostKey),
        ("crypt_cs", MethodType::CryptCs),
        ("crypt_sc", MethodType::CryptSc),
        ("mac_cs", MethodType::MacCs),
        ("mac_sc", MethodType::MacSc),
        ("comp_cs", MethodType::CompCs),
        ("comp_sc", MethodType::CompSc),
    ] {
        match session.supported_algs(method.1) {
            Ok(algs) => println!("{}: {}", method.0, algs.join(",")),
            Err(error) => println!("{}: <error: {}>", method.0, error),
        }
    }
    Ok(())
}
