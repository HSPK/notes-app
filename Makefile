.PHONY: app windows install clean

app:
	zsh ./macOS/Scripts/build.sh

windows:
	pwsh -NoProfile -File ./Windows/Scripts/build.ps1

install: app
	mkdir -p "$(HOME)/Applications"
	rm -rf "$(HOME)/Applications/Notes.app"
	cp -R build/Notes.app "$(HOME)/Applications/Notes.app"

clean:
	rm -rf build
