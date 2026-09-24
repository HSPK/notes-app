use std::collections::{HashMap, VecDeque};

use axum::body::Bytes;
use sha2::{Digest, Sha256};

const MAX_CACHE_BYTES: usize = 16 * 1024 * 1024;
const MAX_CACHE_ENTRIES: usize = 4;
const MAX_CACHED_PREVIEW_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Eq, Hash, PartialEq)]
pub(super) struct Key {
    path: String,
    digest: [u8; 32],
}

impl Key {
    pub(super) fn new(path: &str, content: &str) -> Self {
        Self {
            path: path.to_owned(),
            digest: Sha256::digest(content.as_bytes()).into(),
        }
    }
}

#[derive(Default)]
pub(super) struct Cache {
    entries: HashMap<Key, Bytes>,
    order: VecDeque<Key>,
    bytes: usize,
}

impl Cache {
    pub(super) fn get(&mut self, key: &Key) -> Option<Bytes> {
        let bytes = self.entries.get(key)?.clone();
        if self.order.back() != Some(key) {
            self.order.retain(|candidate| candidate != key);
            self.order.push_back(key.clone());
        }
        Some(bytes)
    }

    pub(super) fn insert(&mut self, key: Key, bytes: Bytes) {
        let size = key.path.len() + bytes.len();
        if size > MAX_CACHED_PREVIEW_BYTES {
            return;
        }
        self.remove(&key);
        while self.entries.len() >= MAX_CACHE_ENTRIES || self.bytes + size > MAX_CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(bytes) = self.entries.remove(&oldest) {
                self.bytes -= oldest.path.len() + bytes.len();
            }
        }
        self.bytes += size;
        self.order.push_back(key.clone());
        self.entries.insert(key, bytes);
    }

    fn remove(&mut self, key: &Key) {
        if let Some(bytes) = self.entries.remove(key) {
            self.bytes -= key.path.len() + bytes.len();
        }
        self.order.retain(|candidate| candidate != key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_is_content_addressed_and_bounded() {
        let mut cache = Cache::default();
        let first = Key::new("note.md", "# First");
        let changed = Key::new("note.md", "# Changed");
        let moved = Key::new("folder/note.md", "# First");
        cache.insert(first.clone(), Bytes::from_static(b"first"));
        assert_eq!(cache.get(&first), Some(Bytes::from_static(b"first")));
        assert_eq!(cache.get(&changed), None);
        assert_eq!(cache.get(&moved), None);

        for index in 0..=MAX_CACHE_ENTRIES {
            cache.insert(
                Key::new(&format!("{index}.md"), "# Preview"),
                Bytes::from_static(b"cached"),
            );
        }
        assert_eq!(cache.entries.len(), MAX_CACHE_ENTRIES);
        assert!(!cache.entries.contains_key(&Key::new("0.md", "# Preview")));
    }
}
