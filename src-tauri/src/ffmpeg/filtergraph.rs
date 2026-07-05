//! `ExportSpec` から `-filter_complex_script` に渡す filtergraph を構築する(DESIGN.md §8)。

use std::path::PathBuf;

use crate::commands::export::{AClip, Effect, ExportSpec, TextAlign, TextStyle, VClip};
use crate::paths;

/// filtergraph 全文を組み立て、`runtime/cache/filter_{jobId}.txt` へ書き出してパスを返す。
pub fn write_filter_script(job_id: &str, spec: &ExportSpec) -> Result<PathBuf, String> {
    let content = build_filter_complex(spec);
    let path = paths::cache_dir().join(format!("filter_{job_id}.txt"));
    std::fs::write(&path, content)
        .map_err(|e| format!("filter_complex_script の書き込みに失敗しました: {e}"))?;
    Ok(path)
}

/// filtergraph のテキストを構築する(単体テスト・呼び出し元での再利用のため公開)。
pub fn build_filter_complex(spec: &ExportSpec) -> String {
    let mut script = String::new();

    script.push_str(&format!(
        "color=c=black:s={}x{}:r={:.6}:d={:.6}[base];\n",
        spec.width, spec.height, spec.fps, spec.duration_sec
    ));

    let mut prev_label = "base".to_string();

    for (i, vc) in spec.video_clips.iter().enumerate() {
        let out_label = format!("m{i}");
        match vc.input_index {
            Some(input_idx) => {
                let vlabel = format!("v{i}");
                script.push_str(&build_media_clip_chain(vc, input_idx, &vlabel, spec.fps));
                script.push_str(&build_overlay(&prev_label, &vlabel, vc, &out_label));
            }
            None => {
                script.push_str(&build_drawtext_chain(vc, &prev_label, &out_label));
            }
        }
        prev_label = out_label;
    }

    if spec.audio_clips.is_empty() {
        script.push_str(&format!(
            "anullsrc=r={}:cl=stereo[aout];\n",
            spec.sample_rate
        ));
    } else {
        let mut labels = Vec::with_capacity(spec.audio_clips.len());
        for (j, ac) in spec.audio_clips.iter().enumerate() {
            let alabel = format!("a{j}");
            script.push_str(&build_audio_chain(ac, &alabel, spec.sample_rate));
            labels.push(format!("[{alabel}]"));
        }
        script.push_str(&format!(
            "{}amix=inputs={}:normalize=0:duration=longest[aout];\n",
            labels.join(""),
            spec.audio_clips.len()
        ));
    }

    // 末尾の ; は古い ffmpeg でパースエラーになり得るため取り除く。
    let trimmed = script.trim_end().trim_end_matches(';');
    trimmed.to_string()
}

fn first_eq(effects: &[Effect]) -> Option<(f64, f64, f64)> {
    effects.iter().find_map(|e| match e {
        Effect::Eq {
            brightness,
            contrast,
            saturation,
        } => Some((*brightness, *contrast, *saturation)),
        Effect::Blur { .. } => None,
    })
}

fn first_blur(effects: &[Effect]) -> Option<f64> {
    effects.iter().find_map(|e| match e {
        Effect::Blur { radius } => Some(*radius),
        Effect::Eq { .. } => None,
    })
}

fn build_media_clip_chain(vc: &VClip, input_idx: usize, label: &str, fps: f64) -> String {
    let mut filters: Vec<String> = Vec::new();

    if vc.is_image {
        // 画像: inPoint=0, speed=1 前提。trim=duration で必要な長さに切り出し、
        // setpts でタイムライン上の開始位置へシフトする。
        filters.push(format!("trim=duration={:.6}", vc.duration));
        filters.push(format!("setpts=PTS-STARTPTS+{:.6}/TB", vc.start));
    } else {
        let out_point = vc.in_point + vc.duration * vc.speed;
        filters.push(format!(
            "trim=start={:.6}:end={:.6}",
            vc.in_point, out_point
        ));
        filters.push(format!(
            "setpts=(PTS-STARTPTS)/{:.6}+{:.6}/TB",
            vc.speed, vc.start
        ));
    }

    filters.push(format!("fps={fps:.6}"));
    filters.push(format!("scale=w=iw*{0:.6}:h=ih*{0:.6}", vc.transform.scale));
    filters.push("format=yuva420p".to_string());

    if vc.transform.rotation.abs() > f64::EPSILON {
        let r = vc.transform.rotation;
        filters.push(format!(
            "rotate={r:.6}*PI/180:ow='rotw({r:.6}*PI/180)':oh='roth({r:.6}*PI/180)':c=black@0"
        ));
    }

    if let Some((b, c, s)) = first_eq(&vc.effects) {
        filters.push(format!(
            "eq=brightness={b:.6}:contrast={c:.6}:saturation={s:.6}"
        ));
    }

    if let Some(radius) = first_blur(&vc.effects) {
        filters.push(format!("gblur=sigma={radius:.6}"));
    }

    if vc.opacity < 1.0 {
        filters.push(format!("colorchannelmixer=aa={:.6}", vc.opacity));
    }

    if vc.fade_in > 0.0 {
        filters.push(format!(
            "fade=t=in:st={:.6}:d={:.6}:alpha=1",
            vc.start, vc.fade_in
        ));
    }
    if vc.fade_out > 0.0 {
        let st = vc.start + vc.duration - vc.fade_out;
        filters.push(format!(
            "fade=t=out:st={:.6}:d={:.6}:alpha=1",
            st, vc.fade_out
        ));
    }

    format!("[{input_idx}:v] {} [{label}];\n", filters.join(", "))
}

fn build_overlay(prev: &str, vlabel: &str, vc: &VClip, out_label: &str) -> String {
    let end = vc.start + vc.duration;
    format!(
        "[{prev}][{vlabel}] overlay=x=(W-w)/2+{:.6}:y=(H-h)/2+{:.6}:eval=init:enable='between(t,{:.6},{:.6})' [{out_label}];\n",
        vc.transform.x, vc.transform.y, vc.start, end
    )
}

/// テキストのエスケープ(DESIGN.md §8: `\ ' : % ,` を適切に)。
/// 1 パスで処理し、既に書き込んだエスケープシーケンスを再エスケープしないようにする。
fn escape_drawtext_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            // filtergraph パーサと option パーサの 2 段階で unescape されるため、
            // リテラルの ' は「quote 終了 + \\ + \' + quote 再開」で二重エスケープする
            // (ffmpeg 実機検証済み。'\'' だけでは 2 段目で quote が剥がれて消える)。
            '\'' => out.push_str("'\\\\\\''"),
            ':' => out.push_str("\\:"),
            '%' => out.push_str("\\%"),
            ',' => out.push_str("\\,"),
            _ => out.push(ch),
        }
    }
    out
}

/// フォントファミリ名から Windows フォントファイル名へのマッピング。
/// 未知のフォントは既定(Meiryo)にフォールバックする。
fn map_font_file(family: &str, bold: bool) -> &'static str {
    match (family, bold) {
        ("Meiryo", false) => "meiryo.ttc",
        ("Meiryo", true) => "meiryob.ttc",
        ("Yu Gothic", false) => "YuGothM.ttc",
        ("Yu Gothic", true) => "YuGothB.ttc",
        ("Arial", false) => "arial.ttf",
        ("Arial", true) => "arialbd.ttf",
        (_, true) => "meiryob.ttc",
        (_, false) => "meiryo.ttc",
    }
}

fn build_drawtext_chain(vc: &VClip, prev: &str, out_label: &str) -> String {
    let text: &TextStyle = match &vc.text {
        Some(t) => t,
        None => {
            // 仕様上テキストクリップは text が非 null であるべきだが、フロントの不正な
            // データを受け取った場合は空文字のテキストとして扱いクラッシュを避ける。
            return format!("[{prev}] null [{out_label}];\n");
        }
    };

    let escaped = escape_drawtext_text(&text.content);
    let end = vc.start + vc.duration;
    let font_file = map_font_file(&text.font_family, text.bold);

    let mut params: Vec<String> = Vec::new();
    params.push(format!("text='{escaped}'"));
    // %{...} 展開は使わないため無効化する。expansion=normal のままだと
    // テキスト中の % が「Stray %」エラーになる(ffmpeg 実機検証済み)。
    params.push("expansion=none".to_string());
    params.push(format!("fontsize={:.6}", text.font_size));
    params.push(format!("fontcolor={}", text.color));
    params.push(format!("fontfile='C\\:/Windows/Fonts/{font_file}'"));

    // transform.x/y はステージ中心からのオフセット。align は水平方向の基準点のみに影響する。
    let cx = format!("(w/2)+{:.6}", vc.transform.x);
    let cy = format!("(h/2)+{:.6}", vc.transform.y);
    let x_expr = match text.align {
        TextAlign::Center => format!("{cx}-(text_w/2)"),
        TextAlign::Left => cx.clone(),
        TextAlign::Right => format!("{cx}-text_w"),
    };
    let y_expr = format!("{cy}-(text_h/2)");
    params.push(format!("x={x_expr}"));
    params.push(format!("y={y_expr}"));

    if let Some(bg) = &text.background {
        params.push("box=1".to_string());
        params.push(format!("boxcolor={bg}@0.6"));
    }

    params.push(format!("enable='between(t,{:.6},{:.6})'", vc.start, end));

    format!("[{prev}] drawtext={} [{out_label}];\n", params.join(":"))
}

/// atempo は 0.5..=2.0 の範囲でしか単体指定できないため、範囲外は複数の atempo に分割する。
fn build_atempo_chain(speed: f64) -> Vec<String> {
    let mut remaining = speed;
    let mut parts = Vec::new();

    if remaining <= 0.0 {
        return vec!["atempo=1.0".to_string()];
    }

    while remaining > 2.0 {
        parts.push("atempo=2.0".to_string());
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        parts.push("atempo=0.5".to_string());
        remaining /= 0.5;
    }
    parts.push(format!("atempo={remaining:.6}"));
    parts
}

fn build_audio_chain(ac: &AClip, label: &str, sample_rate: u32) -> String {
    let out_point = ac.in_point + ac.duration * ac.speed;
    let mut filters: Vec<String> = Vec::new();

    filters.push(format!(
        "atrim=start={:.6}:end={:.6}",
        ac.in_point, out_point
    ));
    filters.push("asetpts=PTS-STARTPTS".to_string());

    if (ac.speed - 1.0).abs() > f64::EPSILON {
        filters.extend(build_atempo_chain(ac.speed));
    }

    filters.push(format!("volume={:.6}", ac.volume));

    if ac.fade_in > 0.0 {
        filters.push(format!("afade=t=in:st=0:d={:.6}", ac.fade_in));
    }
    if ac.fade_out > 0.0 {
        let st = (ac.duration - ac.fade_out).max(0.0);
        filters.push(format!("afade=t=out:st={:.6}:d={:.6}", st, ac.fade_out));
    }

    let delay_ms = (ac.start * 1000.0).round().max(0.0) as i64;
    filters.push(format!("adelay={delay_ms}:all=1"));
    filters.push(format!("aresample={sample_rate}"));

    format!("[{}:a] {} [{label}];\n", ac.input_index, filters.join(", "))
}
