fn main() {
    println!("cargo:rerun-if-changed=Notes.rc");
    println!("cargo:rerun-if-changed=app.manifest");
    println!("cargo:rerun-if-changed=../../Shared/Resources/Notes.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_resource::compile("Notes.rc", embed_resource::NONE)
            .manifest_required()
            .expect("could not embed the Windows icon and manifest");
    }
}
