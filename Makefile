.PHONY: app install clean

app:
	./Scripts/build.sh

install: app
	mkdir -p "$(HOME)/Applications"
	rm -rf "$(HOME)/Applications/Notes.app"
	cp -R build/Notes.app "$(HOME)/Applications/Notes.app"

clean:
	rm -rf build
