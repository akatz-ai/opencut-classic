use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = planRoughCut)]
pub fn plan_rough_cut(value: JsValue) -> Result<JsValue, JsValue> {
    let request =
        serde_wasm_bindgen::from_value(value).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let result = roughcut::plan(request).map_err(|e| JsValue::from_str(&e))?;
    use serde::Serialize;
    result
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
