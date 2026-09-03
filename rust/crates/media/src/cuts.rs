use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutRange {
    pub start_time: i64,
    pub end_time: i64,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutResult {
    pub tracks: Value,
    pub ranges: Vec<CutRange>,
    pub removed_duration: i64,
    pub created_element_ids: Vec<String>,
}

pub fn apply_timeline_cuts(tracks: Value, ranges: Vec<CutRange>) -> Result<CutResult> {
    let ranges = normalize_ranges(ranges);
    let removed_duration = ranges
        .iter()
        .map(|range| range.end_time - range.start_time)
        .sum();
    let mut tracks = tracks;
    let root = tracks.as_object_mut().context("tracks must be an object")?;
    let mut created_element_ids = Vec::new();

    cut_track_list(root.get_mut("overlay"), &ranges, &mut created_element_ids)?;
    cut_track(root.get_mut("main"), &ranges, &mut created_element_ids)?;
    cut_track_list(root.get_mut("audio"), &ranges, &mut created_element_ids)?;

    Ok(CutResult {
        tracks,
        ranges,
        removed_duration,
        created_element_ids,
    })
}

fn normalize_ranges(mut ranges: Vec<CutRange>) -> Vec<CutRange> {
    ranges.retain(|range| range.start_time >= 0 && range.end_time > range.start_time);
    ranges.sort_by_key(|range| range.start_time);
    let mut normalized: Vec<CutRange> = Vec::new();
    for range in ranges {
        if let Some(previous) = normalized.last_mut() {
            if range.start_time <= previous.end_time {
                previous.end_time = previous.end_time.max(range.end_time);
                previous.reason = merge_reasons(previous.reason.take(), range.reason);
                continue;
            }
        }
        normalized.push(range);
    }
    normalized
}

fn merge_reasons(left: Option<String>, right: Option<String>) -> Option<String> {
    match (left, right) {
        (Some(left), Some(right)) if !left.contains(&right) => Some(format!("{left}; {right}")),
        (Some(left), _) => Some(left),
        (_, Some(right)) => Some(right),
        _ => None,
    }
}

fn cut_track_list(
    value: Option<&mut Value>,
    ranges: &[CutRange],
    created_ids: &mut Vec<String>,
) -> Result<()> {
    let tracks = value
        .context("track list is missing")?
        .as_array_mut()
        .context("track list must be an array")?;
    for track in tracks {
        cut_track(Some(track), ranges, created_ids)?;
    }
    Ok(())
}

fn cut_track(
    value: Option<&mut Value>,
    ranges: &[CutRange],
    created_ids: &mut Vec<String>,
) -> Result<()> {
    let track = value
        .context("track is missing")?
        .as_object_mut()
        .context("track must be an object")?;
    let elements = track
        .get_mut("elements")
        .context("track elements are missing")?
        .as_array_mut()
        .context("track elements must be an array")?;
    let mut next = Vec::new();
    for element in elements.drain(..) {
        next.extend(cut_element(element, ranges, created_ids)?);
    }
    *elements = next;
    Ok(())
}

fn cut_element(
    element: Value,
    ranges: &[CutRange],
    created_ids: &mut Vec<String>,
) -> Result<Vec<Value>> {
    let object = element
        .as_object()
        .context("timeline element must be an object")?;
    let start = number(object, "startTime")?;
    let duration = number(object, "duration")?;
    let end = start + duration;
    let overlapping: Vec<&CutRange> = ranges
        .iter()
        .filter(|range| range.start_time < end && range.end_time > start)
        .collect();

    if overlapping.is_empty() {
        let mut shifted = object.clone();
        shifted.insert(
            "startTime".into(),
            Value::from(start - removed_before(ranges, start)),
        );
        return Ok(vec![Value::Object(shifted)]);
    }
    if object
        .get("animations")
        .is_some_and(|value| !value.is_null())
    {
        bail!(
            "agent cuts cannot split animated element {}",
            object
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        );
    }

    let mut cursor = start;
    let mut retained = Vec::new();
    for range in overlapping {
        let cut_start = start.max(range.start_time);
        let cut_end = end.min(range.end_time);
        if cut_start > cursor {
            retained.push((cursor, cut_start));
        }
        cursor = cursor.max(cut_end);
    }
    if cursor < end {
        retained.push((cursor, end));
    }

    let rate = object
        .get("retime")
        .and_then(Value::as_object)
        .and_then(|retime| retime.get("rate"))
        .and_then(Value::as_f64)
        .unwrap_or(1.0);
    let trim_start = number(object, "trimStart")?;
    let trim_end = number(object, "trimEnd")?;
    let original_id = object
        .get("id")
        .and_then(Value::as_str)
        .context("element id is missing")?;
    let original_name = object.get("name").and_then(Value::as_str).unwrap_or("clip");
    let total_source_span = ((duration as f64) * rate).round() as i64;

    retained
        .into_iter()
        .enumerate()
        .map(|(index, (piece_start, piece_end))| {
            let mut piece = object.clone();
            let id = if index == 0 {
                original_id.to_owned()
            } else {
                let id = Uuid::new_v4().to_string();
                created_ids.push(id.clone());
                id
            };
            let local_start = piece_start - start;
            let local_end = piece_end - start;
            let source_start_offset = ((local_start as f64) * rate).round() as i64;
            let source_end_offset = ((local_end as f64) * rate).round() as i64;
            piece.insert("id".into(), Value::String(id));
            if retained_len_hint(&piece, index) {
                piece.insert(
                    "name".into(),
                    Value::String(format!("{original_name} (cut {})", index + 1)),
                );
            }
            piece.insert(
                "startTime".into(),
                Value::from(piece_start - removed_before(ranges, piece_start)),
            );
            piece.insert("duration".into(), Value::from(piece_end - piece_start));
            piece.insert(
                "trimStart".into(),
                Value::from(trim_start + source_start_offset),
            );
            piece.insert(
                "trimEnd".into(),
                Value::from(trim_end + total_source_span - source_end_offset),
            );
            Ok(Value::Object(piece))
        })
        .collect()
}

// Names are diagnostic only; every split piece may be labelled without changing semantics.
fn retained_len_hint(_piece: &Map<String, Value>, index: usize) -> bool {
    index > 0
}

fn removed_before(ranges: &[CutRange], time: i64) -> i64 {
    ranges
        .iter()
        .map(|range| {
            if time <= range.start_time {
                0
            } else {
                time.min(range.end_time) - range.start_time
            }
        })
        .sum()
}

fn number(object: &Map<String, Value>, field: &str) -> Result<i64> {
    object
        .get(field)
        .and_then(Value::as_i64)
        .with_context(|| format!("timeline element {field} must be an integer"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cuts_and_ripples_timeline_elements() {
        let tracks = json!({
            "overlay": [],
            "main": {"elements": [
                {"id":"a","name":"a","type":"video","startTime":0,"duration":100,"trimStart":10,"trimEnd":0},
                {"id":"b","name":"b","type":"video","startTime":100,"duration":100,"trimStart":50,"trimEnd":0}
            ]},
            "audio": []
        });
        let result = apply_timeline_cuts(
            tracks,
            vec![
                CutRange {
                    start_time: 20,
                    end_time: 30,
                    reason: None,
                },
                CutRange {
                    start_time: 80,
                    end_time: 120,
                    reason: None,
                },
            ],
        )
        .unwrap();
        assert_eq!(result.removed_duration, 50);
        let elements = result.tracks["main"]["elements"].as_array().unwrap();
        assert_eq!(elements.len(), 3);
        assert_eq!(elements[0]["duration"], 20);
        assert_eq!(elements[1]["startTime"], 20);
        assert_eq!(elements[1]["trimStart"], 40);
        assert_eq!(elements[2]["startTime"], 70);
        assert_eq!(elements[2]["trimStart"], 70);
    }
}
