use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = fitMotion)]
pub fn fit_motion(value: JsValue, duration: f64) -> Result<JsValue, JsValue> {
    let value =
        serde_wasm_bindgen::from_value(value).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let fitted = motion::fit(value, duration).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&fitted).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen(js_name = splitMotion)]
pub fn split_motion(value: JsValue, left: f64, right: f64) -> Result<JsValue, JsValue> {
    let value =
        serde_wasm_bindgen::from_value(value).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let split = motion::split(value, left, right).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&split).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen(js_name = evaluateMotion)]
pub fn evaluate_motion(
    value: JsValue,
    local_time: f64,
    clip_duration: f64,
) -> Result<JsValue, JsValue> {
    let spec: motion::Motion =
        serde_wasm_bindgen::from_value(value).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let delta =
        motion::evaluate(&spec, local_time, clip_duration).map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&delta).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen(js_name = validateMotionCut)]
pub fn validate_motion_cut(
    outgoing_end: f64,
    incoming_start: f64,
    available_handle: f64,
    duration: f64,
) -> Result<(), JsValue> {
    motion::validate_cut(outgoing_end, incoming_start, available_handle, duration)
        .map_err(|e| JsValue::from_str(&e))
}
