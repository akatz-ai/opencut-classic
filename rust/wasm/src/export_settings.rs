use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = resolveExportDimensions)]
pub fn resolve_export_dimensions(
    width: f64,
    height: f64,
    preset: &str,
) -> Result<JsValue, JsValue> {
    let result = export_settings::resolve_dimensions(width, height, preset)
        .map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen(js_name = fitExportFrame)]
pub fn fit_export_frame(
    width: f64,
    height: f64,
    output_width: u32,
    output_height: u32,
) -> Result<JsValue, JsValue> {
    let result = export_settings::fit_frame(width, height, output_width, output_height)
        .map_err(|e| JsValue::from_str(&e))?;
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsValue::from_str(&e.to_string()))
}
