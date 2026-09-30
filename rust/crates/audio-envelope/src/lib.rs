//! Platform-independent audio clip fade normalization and gain evaluation.

pub fn clamp_duration(clip_duration: f64, requested_duration: f64) -> f64 {
    if !clip_duration.is_finite() || clip_duration <= 0.0 {
        return 0.0;
    }
    if !requested_duration.is_finite() {
        return 0.0;
    }
    requested_duration.clamp(0.0, clip_duration)
}

/// Evaluate a linear-amplitude fade envelope. When fades overlap, the quieter
/// side wins so a pair of full-clip fades makes a natural triangular envelope.
pub fn evaluate_gain(
    clip_duration: f64,
    local_time: f64,
    fade_in_duration: f64,
    fade_out_duration: f64,
) -> f64 {
    if !clip_duration.is_finite() || clip_duration <= 0.0 || !local_time.is_finite() {
        return 1.0;
    }

    let time = local_time.clamp(0.0, clip_duration);
    let fade_in = clamp_duration(clip_duration, fade_in_duration);
    let fade_out = clamp_duration(clip_duration, fade_out_duration);
    let in_gain = if fade_in > 0.0 {
        (time / fade_in).clamp(0.0, 1.0)
    } else {
        1.0
    };
    let out_gain = if fade_out > 0.0 {
        ((clip_duration - time) / fade_out).clamp(0.0, 1.0)
    } else {
        1.0
    };
    in_gain.min(out_gain)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_fades_to_the_clip() {
        assert_eq!(clamp_duration(10.0, -2.0), 0.0);
        assert_eq!(clamp_duration(10.0, 3.0), 3.0);
        assert_eq!(clamp_duration(10.0, 20.0), 10.0);
        assert_eq!(clamp_duration(10.0, f64::NAN), 0.0);
    }

    #[test]
    fn evaluates_linear_fade_in_and_out() {
        assert_eq!(evaluate_gain(10.0, 0.0, 2.0, 3.0), 0.0);
        assert_eq!(evaluate_gain(10.0, 1.0, 2.0, 3.0), 0.5);
        assert_eq!(evaluate_gain(10.0, 5.0, 2.0, 3.0), 1.0);
        assert_eq!(evaluate_gain(10.0, 8.5, 2.0, 3.0), 0.5);
        assert_eq!(evaluate_gain(10.0, 10.0, 2.0, 3.0), 0.0);
    }

    #[test]
    fn overlapping_fades_use_the_quieter_side() {
        assert_eq!(evaluate_gain(10.0, 5.0, 10.0, 10.0), 0.5);
        assert_eq!(evaluate_gain(10.0, 2.0, 10.0, 10.0), 0.2);
    }

    #[test]
    fn no_fades_leave_gain_unchanged() {
        assert_eq!(evaluate_gain(10.0, 0.0, 0.0, 0.0), 1.0);
        assert_eq!(evaluate_gain(10.0, 10.0, 0.0, 0.0), 1.0);
    }
}
