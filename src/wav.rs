//! WAV files: what tests and tools feed through the same pipeline as a microphone, and – in a
//! chunk of Shama's own – what each utterance in them says, for the fixture recognizer.

use serde::{Deserialize, Serialize};

/// Audio as samples between -1 and 1, one channel.
#[derive(Clone, Debug, PartialEq)]
pub struct Wav {
    pub rate: u32,
    pub samples: Vec<f32>,
    /// What the utterances in it say: Shama's "shma" chunk.
    pub transcripts: Vec<Transcript>,
}

/// What is said between two moments of a recording.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WavError(pub String);

impl std::fmt::Display for WavError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "not a WAV Shama reads: {}", self.0)
    }
}

impl std::error::Error for WavError {}

const SHAMA_CHUNK: &[u8; 4] = b"shma";

/// Reads 16-bit PCM or 32-bit float WAV, any rate, its channels mixed to one.
pub fn read(bytes: &[u8]) -> Result<Wav, WavError> {
    let error = |message: &str| WavError(message.to_string());
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(error("no RIFF/WAVE header"));
    }
    let mut format: Option<(u16, u16, u32, u16)> = None;
    let mut data: Option<&[u8]> = None;
    let mut transcripts = Vec::new();
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]) as usize;
        let start = at + 8;
        let end = (start + size).min(bytes.len());
        let body = &bytes[start..end];
        match id {
            b"fmt " if body.len() >= 16 => {
                let tag = u16::from_le_bytes([body[0], body[1]]);
                let channels = u16::from_le_bytes([body[2], body[3]]);
                let rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
                let bits = u16::from_le_bytes([body[14], body[15]]);
                // WAVE_FORMAT_EXTENSIBLE names its format in the sub-format's first two bytes.
                let tag =
                    if tag == 0xFFFE && body.len() >= 26 { u16::from_le_bytes([body[24], body[25]]) } else { tag };
                format = Some((tag, channels, rate, bits));
            }
            b"data" => data = Some(body),
            id if id == SHAMA_CHUNK => {
                transcripts = serde_json::from_slice(body).map_err(|e| WavError(format!("its shma chunk: {e}")))?;
            }
            _ => {}
        }
        at = start + size + (size & 1);
    }
    let (tag, channels, rate, bits) = format.ok_or_else(|| error("no fmt chunk"))?;
    let data = data.ok_or_else(|| error("no data chunk"))?;
    if channels == 0 || rate == 0 {
        return Err(error("no channels or no rate"));
    }
    let channels = channels as usize;
    let frames: Vec<f32> = match (tag, bits) {
        (1, 16) => data.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b) as f32 / 32768.0).collect(),
        (3, 32) => data.as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect(),
        _ => return Err(WavError(format!("format {tag} with {bits} bits; 16-bit PCM or 32-bit float only"))),
    };
    let samples = frames.chunks_exact(channels).map(|frame| frame.iter().sum::<f32>() / channels as f32).collect();
    Ok(Wav { rate, samples, transcripts })
}

/// Writes 16-bit PCM, one channel, with the transcripts in Shama's chunk.
pub fn write(wav: &Wav) -> Vec<u8> {
    let data: Vec<u8> = wav
        .samples
        .iter()
        .flat_map(|sample| ((sample.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes())
        .collect();
    let transcripts =
        if wav.transcripts.is_empty() { Vec::new() } else { serde_json::to_vec(&wav.transcripts).unwrap_or_default() };
    let mut bytes = Vec::with_capacity(44 + data.len() + transcripts.len() + 9);
    let chunk = |bytes: &mut Vec<u8>, id: &[u8; 4], body: &[u8]| {
        bytes.extend_from_slice(id);
        bytes.extend_from_slice(&(body.len() as u32).to_le_bytes());
        bytes.extend_from_slice(body);
        if body.len() % 2 == 1 {
            bytes.push(0);
        }
    };
    bytes.extend_from_slice(b"RIFF\0\0\0\0WAVE");
    let mut format = Vec::with_capacity(16);
    format.extend_from_slice(&1u16.to_le_bytes());
    format.extend_from_slice(&1u16.to_le_bytes());
    format.extend_from_slice(&wav.rate.to_le_bytes());
    format.extend_from_slice(&(wav.rate * 2).to_le_bytes());
    format.extend_from_slice(&2u16.to_le_bytes());
    format.extend_from_slice(&16u16.to_le_bytes());
    chunk(&mut bytes, b"fmt ", &format);
    if !transcripts.is_empty() {
        chunk(&mut bytes, SHAMA_CHUNK, &transcripts);
    }
    chunk(&mut bytes, b"data", &data);
    let size = (bytes.len() - 8) as u32;
    bytes[4..8].copy_from_slice(&size.to_le_bytes());
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn written_and_read_back() {
        let wav = Wav {
            rate: 16000,
            samples: vec![0.0, 0.5, -0.5, 0.25],
            transcripts: vec![Transcript {
                start_ms: 0,
                end_ms: 900,
                text: "lies Psalm 23".into(),
                confidence: Some(0.9),
            }],
        };
        let back = read(&write(&wav)).unwrap();
        assert_eq!(back.rate, 16000);
        assert_eq!(back.transcripts, wav.transcripts);
        for (a, b) in back.samples.iter().zip(&wav.samples) {
            assert!((a - b).abs() < 1e-4);
        }
    }

    #[test]
    fn stereo_float_is_mixed() {
        let mut bytes = b"RIFF\0\0\0\0WAVEfmt ".to_vec();
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&3u16.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&48000u32.to_le_bytes());
        bytes.extend_from_slice(&(48000u32 * 8).to_le_bytes());
        bytes.extend_from_slice(&8u16.to_le_bytes());
        bytes.extend_from_slice(&32u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&8u32.to_le_bytes());
        bytes.extend_from_slice(&0.5f32.to_le_bytes());
        bytes.extend_from_slice(&0.25f32.to_le_bytes());
        let wav = read(&bytes).unwrap();
        assert_eq!((wav.rate, wav.samples.as_slice()), (48000, &[0.375f32][..]));
    }

    #[test]
    fn not_a_wav() {
        assert!(read(b"hello").is_err());
    }
}
