//! UTF-8 streaming decoder helpers.
//!
//! Some provider streaming APIs deliver bytes in arbitrary chunk boundaries.
//! If we decode each chunk independently with `from_utf8_lossy`, multi-byte
//! sequences (CJK/emoji) can be split across chunks and become `�` in the UI.
//!
//! This decoder buffers incomplete UTF-8 sequences across chunk boundaries.

#[derive(Debug, Default)]
pub struct Utf8StreamDecoder {
    buffered: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub fn push(&mut self, chunk: &[u8]) -> String {
        if chunk.is_empty() {
            return String::new();
        }

        self.buffered.extend_from_slice(chunk);

        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.buffered) {
                Ok(s) => {
                    out.push_str(s);
                    self.buffered.clear();
                    break;
                }
                Err(err) => {
                    let valid_up_to = err.valid_up_to();
                    if valid_up_to > 0 {
                        let valid = &self.buffered[..valid_up_to];
                        out.push_str(unsafe { std::str::from_utf8_unchecked(valid) });
                        self.buffered.drain(..valid_up_to);
                        continue;
                    }

                    // No valid prefix. If error_len is None, we have an incomplete sequence at
                    // the end; keep it buffered until the next chunk arrives.
                    let Some(error_len) = err.error_len() else {
                        break;
                    };

                    // Truly invalid byte sequence (should be rare for provider UTF-8 streams).
                    // Drop the invalid bytes and emit the Unicode replacement character.
                    out.push('\u{FFFD}');
                    self.buffered.drain(..error_len);
                }
            }
        }

        out
    }

    pub fn finish_lossy(&mut self) -> String {
        if self.buffered.is_empty() {
            return String::new();
        }
        let out = String::from_utf8_lossy(&self.buffered).into_owned();
        self.buffered.clear();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_boundaries_preserve_emoji_and_cjk() {
        let input = "🔑关键发现：1️⃣ 2️⃣ 3️⃣";
        let bytes = input.as_bytes();

        for split in 1..bytes.len() {
            let mut d = Utf8StreamDecoder::default();
            let mut out = String::new();
            out.push_str(&d.push(&bytes[..split]));
            out.push_str(&d.push(&bytes[split..]));
            out.push_str(&d.finish_lossy());
            assert_eq!(out, input, "split at {split}");
        }
    }

    #[test]
    fn test_incomplete_sequence_is_buffered() {
        let input = "你";
        let bytes = input.as_bytes();

        let mut d = Utf8StreamDecoder::default();
        let first = d.push(&bytes[..1]);
        assert_eq!(first, "");
        let second = d.push(&bytes[1..]);
        assert_eq!(second, input);
        assert_eq!(d.finish_lossy(), "");
    }
}
