//! Audio at the microphone's rate – 48 kHz, 44.1 kHz, 8 kHz on a headset – to the 16 kHz the
//! recognizers take: a Kaiser-windowed sinc that low-passes first, so nothing above 8 kHz folds
//! back into speech as it would with plain interpolation.

use std::f64::consts::PI;

/// The rate recognizers take.
pub const RATE: u32 = 16_000;

/// Zero crossings of the sinc on each side: the filter's length and sharpness.
const ZEROS: f64 = 16.0;
/// Steps of the precomputed filter per input sample.
const PHASES: usize = 256;
const KAISER_BETA: f64 = 8.0;
/// Where the passband ends, as a share of the lower rate's Nyquist frequency.
const PASSBAND: f64 = 0.9;

pub struct Resampler {
    from: u32,
    /// Input samples per output sample.
    step: f64,
    /// Half the filter's length, in input samples.
    half: f64,
    /// The filter's gain at `t` input samples from its middle, every 1/PHASES.
    table: Vec<f32>,
    /// Input not yet used up, starting at `offset` in the stream.
    buffer: Vec<f32>,
    offset: usize,
    /// Where in the input stream the next output sample falls.
    next: f64,
}

impl Resampler {
    pub fn new(from: u32) -> Resampler {
        let from = from.max(1);
        let step = from as f64 / RATE as f64;
        // The cutoff, in cycles per input sample: below both rates' Nyquist frequencies.
        let cutoff = PASSBAND * 0.5 * (RATE as f64 / from as f64).min(1.0);
        let half = (ZEROS / (2.0 * cutoff)).ceil();
        let entries = (half as usize) * PHASES + 2;
        let table = (0..entries)
            .map(|i| {
                let t = i as f64 / PHASES as f64;
                let sinc = if t == 0.0 { 1.0 } else { (2.0 * PI * cutoff * t).sin() / (2.0 * PI * cutoff * t) };
                (2.0 * cutoff * sinc * kaiser(t / half)) as f32
            })
            .collect();
        Resampler { from, step, half, table, buffer: Vec::new(), offset: 0, next: 0.0 }
    }

    pub fn rate(&self) -> u32 {
        self.from
    }

    /// Takes input samples and returns the 16 kHz samples they complete.
    pub fn push(&mut self, input: &[f32]) -> Vec<f32> {
        if self.from == RATE {
            return input.to_vec();
        }
        self.buffer.extend_from_slice(input);
        let mut output = Vec::with_capacity((input.len() as f64 / self.step) as usize + 1);
        let end = (self.offset + self.buffer.len()) as f64;
        while self.next + self.half < end {
            output.push(self.sample_at(self.next));
            self.next += self.step;
        }
        self.trim();
        output
    }

    /// The samples still owed at the end of the stream, as if silence followed.
    pub fn finish(&mut self) -> Vec<f32> {
        if self.from == RATE {
            return Vec::new();
        }
        let end = (self.offset + self.buffer.len()) as f64;
        let mut output = Vec::new();
        while self.next < end {
            output.push(self.sample_at(self.next));
            self.next += self.step;
        }
        self.reset();
        output
    }

    /// Forgets the stream: wipes what it kept, for a new one.
    pub fn reset(&mut self) {
        self.buffer.fill(0.0);
        self.buffer.clear();
        self.offset = 0;
        self.next = 0.0;
    }

    fn sample_at(&self, position: f64) -> f32 {
        let first = (position - self.half).ceil().max(0.0) as usize;
        let last = (position + self.half).floor() as usize;
        let mut sum = 0.0f32;
        for index in first..=last {
            let Some(sample) = index.checked_sub(self.offset).and_then(|i| self.buffer.get(i)) else { continue };
            let distance = (position - index as f64).abs() * PHASES as f64;
            let i = distance as usize;
            let fraction = (distance - i as f64) as f32;
            if i + 1 >= self.table.len() {
                continue;
            }
            let gain = self.table[i] + (self.table[i + 1] - self.table[i]) * fraction;
            sum += sample * gain;
        }
        // The filter's samples one input sample apart add up to one: speech keeps its level,
        // whichever way the rate changes.
        sum
    }

    /// Drops input no output sample will reach any more.
    fn trim(&mut self) {
        let keep_from = (self.next - self.half).floor().max(0.0) as usize;
        if keep_from > self.offset {
            let drop = (keep_from - self.offset).min(self.buffer.len());
            self.buffer[..drop].fill(0.0);
            self.buffer.drain(..drop);
            self.offset += drop;
        }
    }
}

/// The Kaiser window at `x` from -1 to 1.
fn kaiser(x: f64) -> f64 {
    if x.abs() > 1.0 {
        return 0.0;
    }
    bessel_i0(KAISER_BETA * (1.0 - x * x).sqrt()) / bessel_i0(KAISER_BETA)
}

fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let half = x / 2.0;
    for k in 1..50 {
        term *= (half / k as f64) * (half / k as f64);
        sum += term;
        if term < sum * 1e-12 {
            break;
        }
    }
    sum
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, hz: f64, seconds: f64) -> Vec<f32> {
        (0..(rate as f64 * seconds) as usize).map(|i| (2.0 * PI * hz * i as f64 / rate as f64).sin() as f32).collect()
    }

    /// RMS of the middle, away from the edges' transients.
    fn rms(samples: &[f32]) -> f64 {
        let middle = &samples[samples.len() / 4..samples.len() * 3 / 4];
        (middle.iter().map(|s| (*s as f64) * (*s as f64)).sum::<f64>() / middle.len() as f64).sqrt()
    }

    fn resample(rate: u32, input: &[f32]) -> Vec<f32> {
        let mut resampler = Resampler::new(rate);
        let mut output = Vec::new();
        // In pieces, as a microphone delivers them.
        for piece in input.chunks(rate as usize / 100 + 7) {
            output.extend(resampler.push(piece));
        }
        output.extend(resampler.finish());
        output
    }

    #[test]
    fn speech_passes() {
        for rate in [48_000, 44_100, 8_000] {
            let output = resample(rate, &sine(rate, 1000.0, 1.0));
            assert!((output.len() as i64 - 16_000).abs() <= 2, "{rate}: {} samples", output.len());
            let level = rms(&output) / (0.5f64).sqrt();
            assert!((level - 1.0).abs() < 0.01, "{rate}: 1 kHz at {level}");
        }
    }

    #[test]
    fn nothing_folds_back() {
        for (rate, hz) in [(48_000, 12_000.0), (48_000, 9_000.0), (44_100, 15_000.0)] {
            let output = resample(rate, &sine(rate, hz, 1.0));
            let decibels = 20.0 * (rms(&output) / (0.5f64).sqrt()).log10();
            assert!(decibels < -60.0, "{hz} Hz from {rate}: {decibels:.1} dB");
        }
    }

    #[test]
    fn sixteen_khz_passes_through() {
        let input = sine(16_000, 440.0, 0.1);
        assert_eq!(resample(16_000, &input), input);
    }
}
