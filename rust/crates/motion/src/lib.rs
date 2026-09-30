//! Deterministic, platform-neutral transition evaluation. Times share the caller's tick unit.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Fade,
    SlideLeft,
    SlideRight,
    SlideUp,
    SlideDown,
    Pop,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Easing {
    Linear,
    Smooth,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct Transition {
    pub kind: Kind,
    pub duration: f64,
    pub easing: Easing,
}

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Motion {
    pub enter: Option<Transition>,
    pub exit: Option<Transition>,
    /// Play the previous clip's unused picture handle beneath this entrance; audio is unchanged.
    #[serde(default)]
    pub from_previous: bool,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Delta {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub opacity: f64,
}

impl Default for Delta {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            opacity: 1.0,
        }
    }
}

pub fn validate(motion: &Motion, clip_duration: f64) -> Result<(), String> {
    if !clip_duration.is_finite() || clip_duration <= 0.0 {
        return Err("Clip duration must be positive".into());
    }
    let mut total = 0.0;
    for transition in [motion.enter, motion.exit].into_iter().flatten() {
        if !transition.duration.is_finite() || transition.duration <= 0.0 {
            return Err("Transition duration must be positive".into());
        }
        total += transition.duration;
    }
    if total > clip_duration {
        return Err(
            "Entrance and exit durations exceed the clip; shorten or remove a transition".into(),
        );
    }
    if motion.from_previous && motion.enter.is_none() {
        return Err("A between-clips transition requires an entrance".into());
    }
    Ok(())
}

pub fn validate_cut(
    outgoing_end: f64,
    incoming_start: f64,
    available_handle: f64,
    duration: f64,
) -> Result<(), String> {
    if [outgoing_end, incoming_start, available_handle, duration]
        .iter()
        .any(|v| !v.is_finite())
        || duration <= 0.0
        || available_handle < 0.0
    {
        return Err("Invalid transition timing".into());
    }
    if (outgoing_end - incoming_start).abs() > 0.5 {
        return Err("Between-clips transitions need adjacent clips on the same track".into());
    }
    if available_handle < duration {
        return Err("The previous video needs more unused footage after its trim. Trim its end further or shorten the transition; no freeze-frame fallback is used".into());
    }
    Ok(())
}

pub fn evaluate(motion: &Motion, local_time: f64, clip_duration: f64) -> Result<Delta, String> {
    validate(motion, clip_duration)?;
    if !local_time.is_finite() {
        return Err("Motion time must be finite".into());
    }
    let mut result = Delta::default();
    if let Some(enter) = motion.enter {
        if local_time < enter.duration {
            result = phase(enter, local_time / enter.duration);
        }
    }
    if let Some(exit) = motion.exit {
        if local_time > clip_duration - exit.duration {
            result = phase(exit, (clip_duration - local_time) / exit.duration);
            result.x = -result.x;
            result.y = -result.y;
        }
    }
    Ok(result)
}

/// Trimming a clip keeps edge effects, proportionally shortening them only when necessary.
pub fn fit(mut motion: Motion, duration: f64) -> Result<Motion, String> {
    let total = motion.enter.map_or(0.0, |t| t.duration) + motion.exit.map_or(0.0, |t| t.duration);
    validate(&motion, duration.max(total))?;
    if !duration.is_finite() || duration <= 0.0 {
        return Err("Clip duration must be positive".into());
    }
    if total > duration {
        for t in [&mut motion.enter, &mut motion.exit].into_iter().flatten() {
            t.duration *= duration / total;
        }
    }
    Ok(motion)
}

/// A split creates no new transition at the internal cut.
pub fn split(
    motion: Motion,
    left_duration: f64,
    right_duration: f64,
) -> Result<[Motion; 2], String> {
    Ok([
        fit(
            Motion {
                enter: motion.enter,
                exit: None,
                from_previous: motion.from_previous,
            },
            left_duration,
        )?,
        fit(
            Motion {
                enter: None,
                exit: motion.exit,
                from_previous: false,
            },
            right_duration,
        )?,
    ])
}

fn phase(transition: Transition, progress: f64) -> Delta {
    let p = progress.clamp(0.0, 1.0);
    let p = match transition.easing {
        Easing::Linear => p,
        Easing::Smooth => p * p * (3.0 - 2.0 * p),
    };
    let remaining = 1.0 - p;
    let mut result = Delta::default();
    match transition.kind {
        Kind::Fade => result.opacity = p,
        Kind::SlideLeft => result.x = remaining,
        Kind::SlideRight => result.x = -remaining,
        Kind::SlideUp => result.y = remaining,
        Kind::SlideDown => result.y = -remaining,
        Kind::Pop => {
            result.scale = 0.7 + 0.3 * p;
            result.opacity = p;
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn transition(kind: Kind) -> Transition {
        Transition {
            kind,
            duration: 10.0,
            easing: Easing::Linear,
        }
    }
    #[test]
    fn fade_endpoints_and_midpoint() {
        let m = Motion {
            enter: Some(transition(Kind::Fade)),
            ..Default::default()
        };
        assert_eq!(evaluate(&m, 0.0, 40.0).unwrap().opacity, 0.0);
        assert_eq!(evaluate(&m, 5.0, 40.0).unwrap().opacity, 0.5);
        assert_eq!(evaluate(&m, 10.0, 40.0).unwrap().opacity, 1.0);
    }
    #[test]
    fn exit_and_non_sequential_seek() {
        let m = Motion {
            exit: Some(transition(Kind::SlideLeft)),
            ..Default::default()
        };
        assert_eq!(evaluate(&m, 40.0, 40.0).unwrap().x, -1.0);
        assert_eq!(evaluate(&m, 35.0, 40.0).unwrap().x, -0.5);
        assert_eq!(evaluate(&m, 0.0, 40.0).unwrap().x, 0.0);
    }
    #[test]
    fn reject_overlapping_phases_and_invalid_numbers() {
        let m = Motion {
            enter: Some(transition(Kind::Fade)),
            exit: Some(transition(Kind::Pop)),
            from_previous: false,
        };
        assert!(validate(&m, 19.0).is_err());
        assert!(validate(&m, f64::NAN).is_err());
        assert!(evaluate(&m, f64::INFINITY, 40.0).is_err());
    }
    #[test]
    fn source_handles_and_adjacency_are_required() {
        assert!(validate_cut(100.0, 100.0, 10.0, 10.0).is_ok());
        assert!(validate_cut(100.0, 100.0, 9.0, 10.0).is_err());
        assert!(validate_cut(100.0, 101.0, 20.0, 10.0).is_err());
    }
    #[test]
    fn trimming_fits_and_splitting_keeps_only_original_edges() {
        let m = Motion {
            enter: Some(transition(Kind::Fade)),
            exit: Some(transition(Kind::Pop)),
            from_previous: true,
        };
        let fitted = fit(m.clone(), 10.0).unwrap();
        assert_eq!(fitted.enter.unwrap().duration, 5.0);
        assert_eq!(fitted.exit.unwrap().duration, 5.0);
        let [left, right] = split(m, 5.0, 25.0).unwrap();
        assert_eq!(left.enter.unwrap().duration, 5.0);
        assert!(left.from_previous && left.exit.is_none());
        assert!(!right.from_previous && right.enter.is_none());
        assert_eq!(right.exit.unwrap().duration, 10.0);
    }
}
