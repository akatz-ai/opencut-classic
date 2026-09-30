//! Pure transactional timeline planning. No filesystem, browser, or live editor state.
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub tracks: Value,
    pub media: Vec<Value>,
    pub fps: f64,
    pub definitions: HashMap<String, Vec<Value>>,
    pub operations: Vec<Operation>,
}

#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    AddTrack {
        id: String,
        kind: String,
        name: String,
    },
    Insert {
        id: String,
        track_id: String,
        kind: String,
        #[serde(default)]
        media_id: Option<String>,
        #[serde(default)]
        definition_id: Option<String>,
        start_seconds: f64,
        duration_seconds: f64,
        #[serde(default)]
        source_in_seconds: f64,
        #[serde(default)]
        params: Map<String, Value>,
    },
    SetParams {
        id: String,
        params: Map<String, Value>,
    },
    Move {
        id: String,
        track_id: String,
        start_seconds: f64,
    },
    Remove {
        id: String,
    },
    SetEffect {
        id: String,
        effect_id: String,
        effect_type: String,
        #[serde(default)]
        params: Map<String, Value>,
        #[serde(default = "yes")]
        enabled: bool,
    },
    SetMotion {
        id: String,
        edge: String,
        kind: Option<String>,
        #[serde(default)]
        duration_seconds: f64,
        #[serde(default = "smooth")]
        easing: String,
    },
}
fn yes() -> bool {
    true
}
fn smooth() -> String {
    "smooth".into()
}
type Result<T> = std::result::Result<T, String>;
fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().ok_or_else(|| format!("Missing {key}"))
}
fn valid_id(id: &str) -> Result<()> {
    if id.is_empty()
        || id.len() > 100
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("IDs must be 1-100 letters, numbers, hyphens or underscores".into());
    }
    Ok(())
}
fn ticks(seconds: f64, fps: f64) -> Result<i64> {
    if !seconds.is_finite() || !(0.0..=86400.0).contains(&seconds) {
        return Err("Time must be finite and between 0 and 86400 seconds".into());
    }
    Ok(((seconds * fps).round() * 120000.0 / fps).round() as i64)
}
fn elements(track: &Value) -> Result<&Vec<Value>> {
    track["elements"]
        .as_array()
        .ok_or("Invalid track elements".into())
}
fn compatible(track: &Value, kind: &str) -> bool {
    track["type"] == kind || (track["type"] == "video" && kind == "image")
}
fn locate(tracks: &[Value], id: &str) -> Result<(usize, usize)> {
    for (ti, t) in tracks.iter().enumerate() {
        for (ei, e) in elements(t)?.iter().enumerate() {
            if e["id"] == id {
                return Ok((ti, ei));
            }
        }
    }
    Err(format!("Clip {id} not found"))
}
fn target(tracks: &[Value], id: &str) -> Result<usize> {
    tracks
        .iter()
        .position(|t| t["id"] == id)
        .ok_or_else(|| format!("Track {id} not found"))
}
fn schema_key(e: &Value) -> Result<String> {
    let kind = field(e, "type")?;
    Ok(if kind == "graphic" {
        format!("graphic:{}", field(e, "definitionId")?)
    } else {
        kind.into()
    })
}
fn params(
    defs: &HashMap<String, Vec<Value>>,
    key: &str,
    values: &Map<String, Value>,
    defaults: bool,
) -> Result<Map<String, Value>> {
    let spec = defs
        .get(key)
        .ok_or_else(|| format!("Unsupported definition {key}"))?;
    let mut result = Map::new();
    if defaults {
        for p in spec {
            result.insert(field(p, "key")?.into(), p["default"].clone());
        }
    }
    for (name, value) in values {
        let p = spec
            .iter()
            .find(|p| p["key"] == *name)
            .ok_or_else(|| format!("Unknown parameter {key}.{name}"))?;
        let valid = match p["type"].as_str() {
            Some("number") => value.as_f64().is_some_and(|n| {
                n.is_finite()
                    && n >= p["min"].as_f64().unwrap_or(-1e6)
                    && n <= p["max"].as_f64().unwrap_or(1e6)
            }),
            Some("boolean") => value.is_boolean(),
            Some("select") => p["options"]
                .as_array()
                .is_some_and(|o| o.iter().any(|o| o["value"] == *value)),
            Some("color") => value.as_str().is_some_and(|s| {
                (s.len() == 7 || s.len() == 9)
                    && s.starts_with('#')
                    && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
            }),
            _ => value.as_str().is_some_and(|s| s.len() <= 4000),
        };
        if !valid {
            return Err(format!("Invalid value for {key}.{name}"));
        }
        result.insert(name.clone(), value.clone());
    }
    Ok(result)
}

pub fn plan(request: Request) -> Result<Value> {
    let Request {
        tracks,
        media,
        fps,
        definitions,
        operations,
    } = request;
    if !fps.is_finite() || !(1.0..=240.0).contains(&fps) {
        return Err("Unsupported project frame rate".into());
    }
    if operations.is_empty() || operations.len() > 100 {
        return Err("A batch must have 1-100 operations".into());
    }
    let main = tracks["main"].clone();
    let main_id = field(&main, "id")?.to_owned();
    let mut all = vec![main];
    all.extend(
        tracks["overlay"]
            .as_array()
            .ok_or("Missing overlay tracks")?
            .clone(),
    );
    all.extend(
        tracks["audio"]
            .as_array()
            .ok_or("Missing audio tracks")?
            .clone(),
    );
    let mut ids = HashSet::new();
    for t in &all {
        if !ids.insert(field(t, "id")?.to_owned()) {
            return Err("Duplicate IDs".into());
        }
        for e in elements(t)? {
            if !ids.insert(field(e, "id")?.to_owned()) {
                return Err("Duplicate IDs".into());
            }
        }
    }
    let mut changed = HashSet::new();
    let mut touched = HashSet::new();
    for op in operations {
        match op {
            Operation::AddTrack { id, kind, name } => {
                valid_id(&id)?;
                if !["video", "audio", "text", "graphic"].contains(&kind.as_str())
                    || name.len() > 200
                    || !ids.insert(id.clone())
                {
                    return Err("Invalid or duplicate new track".into());
                }
                // First overlay is topmost. Explicit creation keeps placement predictable.
                changed.insert(id.clone());
                all.insert(1,json!({"id":id,"type":kind,"name":name,"elements":[],"hidden":false,"muted":false}));
            }
            Operation::Insert {
                id,
                track_id,
                kind,
                media_id,
                definition_id,
                start_seconds,
                duration_seconds,
                source_in_seconds,
                params: values,
            } => {
                valid_id(&id)?;
                if !ids.insert(id.clone()) {
                    return Err(format!("Duplicate ID {id}"));
                }
                let ti = target(&all, &track_id)?;
                if !compatible(&all[ti], &kind) {
                    return Err("Clip type is incompatible with target track".into());
                }
                let start = ticks(start_seconds, fps)?;
                let duration = ticks(duration_seconds, fps)?;
                if duration <= 0 {
                    return Err("Clip duration must be at least one frame".into());
                }
                let mut e = json!({"id":id,"type":kind,"name":kind,"startTime":start,"duration":duration,"trimStart":0,"trimEnd":0});
                match kind.as_str() {
                    "video" | "audio" | "image" => {
                        let mid = media_id.ok_or("mediaId is required")?;
                        let m = media
                            .iter()
                            .find(|m| m["id"] == mid)
                            .ok_or("Media not found")?;
                        if m["type"] != kind {
                            return Err("Media type does not match clip type".into());
                        }
                        e["mediaId"] = json!(mid);
                        e["name"] = m["name"].clone();
                        if kind != "image" {
                            let seconds = m["durationSeconds"]
                                .as_f64()
                                .ok_or("Media duration unavailable")?;
                            if !seconds.is_finite() || !(0.0..=86400.0).contains(&seconds) {
                                return Err("Invalid source duration".into());
                            }
                            let source = (seconds * 120000.0).round() as i64;
                            let trim = ticks(source_in_seconds, fps)?;
                            if trim + duration > source {
                                return Err("Source range exceeds media duration".into());
                            }
                            e["sourceDuration"] = json!(source);
                            e["trimStart"] = json!(trim);
                            e["trimEnd"] = json!(source - trim - duration);
                        } else if source_in_seconds != 0.0 {
                            return Err("Images have no source in-point".into());
                        }
                        if kind == "audio" {
                            e["sourceType"] = json!("upload");
                        }
                        if kind == "video" {
                            e["isSourceAudioEnabled"] = json!(true);
                        }
                    }
                    "text" => {
                        if source_in_seconds != 0.0 {
                            return Err("Text has no source in-point".into());
                        }
                    }
                    "graphic" => {
                        if source_in_seconds != 0.0 {
                            return Err("Graphics have no source in-point".into());
                        }
                        e["definitionId"] = json!(definition_id.ok_or("definitionId is required")?);
                    }
                    _ => return Err("Unsupported insertion type".into()),
                }
                e["params"] = Value::Object(params(&definitions, &schema_key(&e)?, &values, true)?);
                all[ti]["elements"].as_array_mut().unwrap().push(e);
                changed.insert(id);
                touched.insert(track_id);
            }
            Operation::SetParams { id, params: values } => {
                let (ti, ei) = locate(&all, &id)?;
                let e = &mut all[ti]["elements"][ei];
                if e.get("animations").is_some_and(|v| !v.is_null()) {
                    return Err("Parameter editing of animated clips is not supported in v1".into());
                }
                let checked = params(&definitions, &schema_key(e)?, &values, false)?;
                e["params"]
                    .as_object_mut()
                    .ok_or("Clip params missing")?
                    .extend(checked);
                changed.insert(id);
            }
            Operation::Move {
                id,
                track_id,
                start_seconds,
            } => {
                let (ti, ei) = locate(&all, &id)?;
                let dest = target(&all, &track_id)?;
                if !compatible(&all[dest], field(&all[ti]["elements"][ei], "type")?) {
                    return Err("Incompatible target track".into());
                }
                touched.insert(field(&all[ti], "id")?.to_owned());
                touched.insert(track_id);
                let mut e = all[ti]["elements"].as_array_mut().unwrap().remove(ei);
                e["startTime"] = json!(ticks(start_seconds, fps)?);
                all[dest]["elements"].as_array_mut().unwrap().push(e);
                changed.insert(id);
            }
            Operation::Remove { id } => {
                let (ti, ei) = locate(&all, &id)?;
                touched.insert(field(&all[ti], "id")?.to_owned());
                all[ti]["elements"].as_array_mut().unwrap().remove(ei);
                changed.insert(id);
            }
            Operation::SetEffect {
                id,
                effect_id,
                effect_type,
                params: values,
                enabled,
            } => {
                valid_id(&effect_id)?;
                let (ti, ei) = locate(&all, &id)?;
                let e = &mut all[ti]["elements"][ei];
                if !["video", "image", "graphic", "text", "sticker"].contains(&field(e, "type")?) {
                    return Err("Effects require a visual clip".into());
                }
                if e.get("animations").is_some_and(|v| !v.is_null()) {
                    return Err("Effect editing of animated clips is not supported in v1".into());
                }
                let p = params(
                    &definitions,
                    &format!("effect:{effect_type}"),
                    &values,
                    true,
                )?;
                if e.get("effects").is_none() {
                    e["effects"] = json!([]);
                }
                let effects = e["effects"].as_array_mut().ok_or("Invalid effect list")?;
                let new = json!({"id":effect_id,"type":effect_type,"params":p,"enabled":enabled});
                if let Some(old) = effects.iter_mut().find(|e| e["id"] == effect_id) {
                    *old = new;
                } else {
                    effects.push(new);
                }
                changed.insert(id);
            }
            Operation::SetMotion {
                id,
                edge,
                kind,
                duration_seconds,
                easing,
            } => {
                let (ti, ei) = locate(&all, &id)?;
                let e = &mut all[ti]["elements"][ei];
                if !["video", "image", "graphic", "text", "sticker"].contains(&field(e, "type")?) {
                    return Err("Motion requires a visual clip".into());
                }
                if !["enter", "exit", "cut"].contains(&edge.as_str()) {
                    return Err("Motion edge must be enter, exit, or cut".into());
                }
                let key = if edge == "exit" { "exit" } else { "enter" };
                if e.get("motion").is_none_or(Value::is_null) {
                    e["motion"] = json!({});
                }
                if let Some(kind) = kind {
                    e["motion"][key] = json!({"kind":kind,"duration":ticks(duration_seconds,fps)?,"easing":easing});
                } else {
                    e["motion"].as_object_mut().unwrap().remove(key);
                }
                if key == "enter" {
                    e["motion"]["fromPrevious"] =
                        json!(edge == "cut" && !e["motion"][key].is_null());
                }
                let m: motion::Motion =
                    serde_json::from_value(e["motion"].clone()).map_err(|e| e.to_string())?;
                motion::evaluate(&m, 0.0, e["duration"].as_f64().ok_or("Missing duration")?)?;
                changed.insert(id);
            }
        }
    }
    for t in &mut all {
        if touched.contains(field(t, "id")?) {
            let es = t["elements"].as_array_mut().unwrap();
            es.sort_by_key(|e| e["startTime"].as_i64().unwrap_or(0));
            for pair in es.windows(2) {
                if pair[0]["startTime"].as_i64().unwrap_or(0)
                    + pair[0]["duration"].as_i64().unwrap_or(0)
                    > pair[1]["startTime"].as_i64().unwrap_or(0)
                {
                    return Err(
                        "Clips overlap on the same track; use a separate overlay track".into(),
                    );
                }
            }
        }
    }
    let mut output = tracks;
    output["main"] = all.iter().find(|t| t["id"] == main_id).unwrap().clone();
    output["overlay"] = json!(
        all.iter()
            .filter(|t| t["id"] != main_id && t["type"] != "audio")
            .collect::<Vec<_>>()
    );
    output["audio"] = json!(
        all.iter()
            .filter(|t| t["type"] == "audio")
            .collect::<Vec<_>>()
    );
    let mut changed: Vec<_> = changed.into_iter().collect();
    changed.sort();
    Ok(json!({"tracks":output,"changedIds":changed}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(ops: Value) -> Value {
        json!({"tracks":{"main":{"id":"main","type":"video","elements":[],"muted":false},"overlay":[],"audio":[],"extra":"preserved"},
        "media":[{"id":"media","type":"video","name":"Source","durationSeconds":10}],"fps":30,
        "definitions":{"video":[{"key":"opacity","type":"number","default":1,"min":0,"max":1}],"text":[{"key":"content","type":"text","default":"Text"}],"graphic:arrow":[],"effect:blur":[{"key":"radius","type":"number","default":5,"min":0,"max":100}]},"operations":ops})
    }
    fn insert() -> Value {
        json!({"op":"insert","id":"clip","trackId":"main","kind":"video","mediaId":"media","startSeconds":0,"durationSeconds":2,"sourceInSeconds":1})
    }
    fn run(v: Value) -> Result<Value> {
        plan(serde_json::from_value(v).map_err(|e| e.to_string())?)
    }
    #[test]
    fn insert_is_frame_aligned_and_preserves_document() {
        let mut op = insert();
        op["startSeconds"] = json!(0.02);
        let result = run(fixture(json!([op]))).unwrap();
        let e = &result["tracks"]["main"]["elements"][0];
        assert_eq!(e["startTime"], 4000);
        assert_eq!(e["trimStart"], 120000);
        assert_eq!(e["trimEnd"], 840000);
        assert_eq!(e["params"]["opacity"], 1);
        assert_eq!(result["tracks"]["extra"], "preserved");
    }
    #[test]
    fn rejects_source_overrun_and_subframe_duration() {
        for duration in [11.0, 0.001, -1.0] {
            let mut op = insert();
            op["durationSeconds"] = json!(duration);
            assert!(run(fixture(json!([op]))).is_err());
        }
    }
    #[test]
    fn rejects_unknown_operations_fields_parameters_and_bad_values() {
        for op in [
            json!({"op":"eval","code":"x"}),
            json!({"op":"remove","id":"x","extra":true}),
        ] {
            assert!(run(fixture(json!([op]))).is_err());
        }
        for values in [
            json!({"bad":1}),
            json!({"opacity":2}),
            json!({"opacity":"yes"}),
        ] {
            let mut op = insert();
            op["params"] = values;
            assert!(run(fixture(json!([op]))).is_err());
        }
    }
    #[test]
    fn rejects_collisions_and_duplicate_ids() {
        for second_id in ["clip", "other"] {
            let mut second = insert();
            second["id"] = json!(second_id);
            assert!(run(fixture(json!([insert(), second]))).is_err());
        }
    }
    #[test]
    fn batch_can_build_and_update_layers() {
        let result=run(fixture(json!([insert(),{"op":"addTrack","id":"titles","kind":"text","name":"Titles"},{"op":"insert","id":"title","trackId":"titles","kind":"text","startSeconds":0,"durationSeconds":2,"params":{"content":"Hello"}},{"op":"setEffect","id":"clip","effectId":"fx","effectType":"blur"},{"op":"setMotion","id":"title","edge":"enter","kind":"pop","durationSeconds":0.3},{"op":"setParams","id":"clip","params":{"opacity":0.5}}]))).unwrap();
        assert_eq!(
            result["tracks"]["overlay"][0]["elements"][0]["params"]["content"],
            "Hello"
        );
        assert_eq!(
            result["tracks"]["main"]["elements"][0]["effects"][0]["params"]["radius"],
            5
        );
        assert_eq!(
            result["tracks"]["main"]["elements"][0]["params"]["opacity"],
            0.5
        );
    }
    #[test]
    fn rejects_incompatible_tracks() {
        let mut op = insert();
        op["kind"] = json!("text");
        assert!(run(fixture(json!([op]))).is_err());
    }
    #[test]
    fn failure_cannot_mutate_original() {
        let original = fixture(json!([insert(),{"op":"remove","id":"missing"}]));
        assert!(run(original.clone()).is_err());
        assert_eq!(original["tracks"]["main"]["elements"], json!([]));
    }
    #[test]
    fn move_and_remove_are_non_rippling() {
        let result = run(fixture(
            json!([insert(),{"op":"move","id":"clip","trackId":"main","startSeconds":4}]),
        ))
        .unwrap();
        assert_eq!(result["tracks"]["main"]["elements"][0]["startTime"], 480000);
        let result = run(fixture(json!([insert(),{"op":"remove","id":"clip"}]))).unwrap();
        assert_eq!(result["tracks"]["main"]["elements"], json!([]));
    }
    #[test]
    fn invalid_motion_fails() {
        assert!(run(fixture(json!([insert(),{"op":"setMotion","id":"clip","edge":"enter","kind":"fade","durationSeconds":3}]))).is_err());
    }
}
