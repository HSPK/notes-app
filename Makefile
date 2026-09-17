.PHONY: app windows core web test install clean

app:
	zsh ./macOS/Scripts/build.sh

windows:
	pwsh -NoProfile -File ./Windows/Scripts/build.ps1

core:
	cargo build --locked --release -p notes-cli --target-dir build/rust

web:
	npm --prefix web ci
	npm --prefix web run build

test:
	cargo test --locked --workspace --target-dir build/rust
	npm --prefix web test

install: app
	mkdir -p "$(HOME)/Applications"
	rm -rf "$(HOME)/Applications/Notes.app"
	cp -R build/Notes.app "$(HOME)/Applications/Notes.app"

clean:
	rm -rf build
