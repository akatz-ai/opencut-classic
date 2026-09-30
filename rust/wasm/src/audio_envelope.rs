use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = clampAudioFadeDuration)]
pub fn clamp_audio_fade_duration(clip_duration: f64, requested_duration: f64) -> f64 {
    audio_envelope::clamp_duration(clip_duration, requested_duration)
}

#[wasm_bindgen(js_name = evaluateAudioFadeGain)]
pub fn evaluate_audio_fade_gain(
    clip_duration: f64,
    local_time: f64,
    fade_in_duration: f64,
    fade_out_duration: f64,
) -> f64 {
    audio_envelope::evaluate_gain(
        clip_duration,
        local_time,
        fade_in_duration,
        fade_out_duration,
    )
}
