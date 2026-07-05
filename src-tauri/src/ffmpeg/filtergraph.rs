//! `ExportSpec` から `-filter_complex_script` に渡す filtergraph を構築する(DESIGN.md §8, §13.2)。

use std::path::PathBuf;

use crate::commands::export::{
    AClip, Effect, ExportSpec, MosaicRegion, TextAlign, TextStyle, VClip,
};
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
                script.push_str(&build_media_clip_chain(vc, i, input_idx, &vlabel, spec.fps));
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

/// メディアクリップのチェーン(DESIGN.md §13.2 で再構成)。
///
/// クリップローカル時間(0..duration)で処理し、最後に `setpts=PTS+start/TB` で
/// タイムライン位置へシフトする:
/// `trim → setpts(ローカル化+speed) → fps → [モザイク] → scale → format → rotate →
///  eq → gblur → colorchannelmixer → fade(st はローカル) → setpts=PTS+start/TB`
///
/// これによりモザイクの geq 内時間変数 `T` がキーフレーム time と直接一致する。
fn build_media_clip_chain(
    vc: &VClip,
    clip_idx: usize,
    input_idx: usize,
    label: &str,
    fps: f64,
) -> String {
    // 前段: 入力をクリップローカル時間へ正規化する。
    let mut pre: Vec<String> = Vec::new();

    if vc.is_image {
        // 画像: inPoint=0, speed=1 前提。trim=duration で必要な長さに切り出す。
        pre.push(format!("trim=duration={:.6}", vc.duration));
        pre.push("setpts=PTS-STARTPTS".to_string());
    } else {
        let out_point = vc.in_point + vc.duration * vc.speed;
        pre.push(format!(
            "trim=start={:.6}:end={:.6}",
            vc.in_point, out_point
        ));
        pre.push(format!("setpts=(PTS-STARTPTS)/{:.6}", vc.speed));
    }

    pre.push(format!("fps={fps:.6}"));

    // 後段: モザイク適用後の変形・エフェクト・フェード。最後にタイムラインへシフト。
    let mut post: Vec<String> = Vec::new();

    post.push(format!("scale=w=iw*{0:.6}:h=ih*{0:.6}", vc.transform.scale));
    post.push("format=yuva420p".to_string());

    if vc.transform.rotation.abs() > f64::EPSILON {
        let r = vc.transform.rotation;
        post.push(format!(
            "rotate={r:.6}*PI/180:ow='rotw({r:.6}*PI/180)':oh='roth({r:.6}*PI/180)':c=black@0"
        ));
    }

    if let Some((b, c, s)) = first_eq(&vc.effects) {
        post.push(format!(
            "eq=brightness={b:.6}:contrast={c:.6}:saturation={s:.6}"
        ));
    }

    if let Some(radius) = first_blur(&vc.effects) {
        post.push(format!("gblur=sigma={radius:.6}"));
    }

    if vc.opacity < 1.0 {
        post.push(format!("colorchannelmixer=aa={:.6}", vc.opacity));
    }

    if vc.fade_in > 0.0 {
        post.push(format!("fade=t=in:st=0:d={:.6}:alpha=1", vc.fade_in));
    }
    if vc.fade_out > 0.0 {
        let st = (vc.duration - vc.fade_out).max(0.0);
        post.push(format!(
            "fade=t=out:st={:.6}:d={:.6}:alpha=1",
            st, vc.fade_out
        ));
    }

    post.push(format!("setpts=PTS+{:.6}/TB", vc.start));

    match build_mosaic_stages(vc, clip_idx, fps) {
        None => format!(
            "[{input_idx}:v] {}, {} [{label}];\n",
            pre.join(", "),
            post.join(", ")
        ),
        Some((stages, last_label)) => {
            let mut s = format!("[{input_idx}:v] {} [v{clip_idx}p];\n", pre.join(", "));
            s.push_str(&stages);
            s.push_str(&format!("[{last_label}] {} [{label}];\n", post.join(", ")));
            s
        }
    }
}

/// モザイク領域のフィルタ段(DESIGN.md §13.2)を構築する。
///
/// 入力は `[v{clip_idx}p]`(クリップローカル時間・ソース解像度)。適用対象の region が
/// 無い、またはソース解像度が不明な場合は None。戻り値は (フィルタ文, 最終出力ラベル)。
///
/// region ごとの構成(実機検証済みプロトタイプの一般化):
/// ```text
/// [in]split[o][x];
/// [x]scale=ceil(iw/{bs}):ceil(ih/{bs}),scale={W}:{H}:flags=neighbor,format=yuva420p[pix];
/// color=c=black:s={ceil(W/4)}x{ceil(H/4)}:r={fps}:d={durLocal}[mb];
/// [mb]geq=lum='...':cb=128:cr=128,format=gray,scale={W}:{H}[mask];
/// [pix][mask]alphamerge[pixa];
/// [o][pixa]overlay=0:0[out]
/// ```
/// マスクは 1/4 解像度で生成し(性能対策)、geq 内で X/Y を 4 倍してフル解像度の
/// ソース座標に換算する。時間変数は `T`(クリップローカル秒)。
fn build_mosaic_stages(vc: &VClip, clip_idx: usize, fps: f64) -> Option<(String, String)> {
    let regions: Vec<&MosaicRegion> = vc
        .mosaics
        .iter()
        .filter(|r| r.enabled && !r.keyframes.is_empty())
        .collect();
    if regions.is_empty() {
        return None;
    }

    // W/H はソース解像度(assetW/assetH)。不明な場合はモザイクをスキップする。
    let (w, h) = match (vc.asset_w, vc.asset_h) {
        (Some(w), Some(h)) if w >= 1.0 && h >= 1.0 => (w.round() as u32, h.round() as u32),
        _ => return None,
    };
    let mask_w = w.div_ceil(4);
    let mask_h = h.div_ceil(4);

    let mut script = String::new();
    let mut cur = format!("v{clip_idx}p");

    for (r, region) in regions.iter().enumerate() {
        // ラベル接頭辞はクリップ・region ごとに一意にする。
        let p = format!("v{clip_idx}m{r}");
        let bs = region.block_size.clamp(1.0, 1024.0);

        // 防御的に time 昇順へソートしてから区分線形式を生成する。
        let mut kfs = region.keyframes.clone();
        kfs.sort_by(|a, b| a.time.total_cmp(&b.time));

        let cx = piecewise_expr(&kfs.iter().map(|k| (k.time, k.cx)).collect::<Vec<_>>());
        let cy = piecewise_expr(&kfs.iter().map(|k| (k.time, k.cy)).collect::<Vec<_>>());
        let rw = piecewise_expr(&kfs.iter().map(|k| (k.time, k.w)).collect::<Vec<_>>());
        let rh = piecewise_expr(&kfs.iter().map(|k| (k.time, k.h)).collect::<Vec<_>>());
        let rot = piecewise_expr(&kfs.iter().map(|k| (k.time, k.rotation)).collect::<Vec<_>>());
        let vis = step_expr(
            &kfs.iter()
                .map(|k| (k.time, if k.visible { 1.0 } else { 0.0 }))
                .collect::<Vec<_>>(),
        );

        // 1/4 解像度マスク上の (X,Y) をソース座標へ換算(*4)し、領域中心へ平行移動 →
        // 領域回転の逆回転 → 軸平行の内外判定。visible(0/1)を乗算する。
        let geq = format!(
            "st(0,X*4-({cx}));st(1,Y*4-({cy}));st(4,({rot})*PI/180);\
             st(2,ld(0)*cos(ld(4))+ld(1)*sin(ld(4)));st(3,-ld(0)*sin(ld(4))+ld(1)*cos(ld(4)));\
             255*lt(abs(ld(2)),({rw})/2)*lt(abs(ld(3)),({rh})/2)*({vis})"
        );

        script.push_str(&format!("[{cur}]split[{p}o][{p}x];\n"));
        script.push_str(&format!(
            "[{p}x]scale=ceil(iw/{bs}):ceil(ih/{bs}),scale={w}:{h}:flags=neighbor,format=yuva420p[{p}pix];\n",
            bs = fmt_num(bs)
        ));
        script.push_str(&format!(
            "color=c=black:s={mask_w}x{mask_h}:r={fps:.6}:d={:.6}[{p}mb];\n",
            vc.duration
        ));
        script.push_str(&format!(
            "[{p}mb]geq=lum='{geq}':cb=128:cr=128,format=gray,scale={w}:{h}[{p}mask];\n"
        ));
        script.push_str(&format!("[{p}pix][{p}mask]alphamerge[{p}pixa];\n"));
        script.push_str(&format!("[{p}o][{p}pixa]overlay=0:0[{p}out];\n"));

        cur = format!("{p}out");
    }

    Some((script, cur))
}

/// f64 を ffmpeg 式向けに整形する(末尾の 0 と小数点を除去)。
fn fmt_num(v: f64) -> String {
    let s = format!("{v:.6}");
    let trimmed = s.trim_end_matches('0').trim_end_matches('.');
    if trimmed.is_empty() || trimmed == "-" || trimmed == "-0" {
        "0".to_string()
    } else {
        trimmed.to_string()
    }
}

/// キーフレーム列 (time, value) から区分線形の ffmpeg 式を生成する(DESIGN.md §13.2)。
///
/// 時間変数は `T`。隣接キーフレーム間は線形補間、最初以前・最後以降はホールド。
/// キーフレームが 1 個なら定数。同時刻(dt≈0)の区間はゼロ除算を避けて左値で潰す。
fn piecewise_expr(kfs: &[(f64, f64)]) -> String {
    match kfs {
        [] => "0".to_string(),
        [(_, v)] => fmt_num(*v),
        _ => {
            // 最後以降のホールド値から内側へ畳み込む。
            let mut expr = fmt_num(kfs[kfs.len() - 1].1);
            for i in (0..kfs.len() - 1).rev() {
                let (t0, v0) = kfs[i];
                let (t1, v1) = kfs[i + 1];
                let dt = t1 - t0;
                let seg = if dt <= 1e-9 {
                    fmt_num(v0)
                } else {
                    format!(
                        "({})+({})*(T-({}))/({})",
                        fmt_num(v0),
                        fmt_num(v1 - v0),
                        fmt_num(t0),
                        fmt_num(dt)
                    )
                };
                expr = format!("if(lt(T,{}),{},{})", fmt_num(t1), seg, expr);
            }
            // 最初のキーフレーム以前はホールド(線形式の外挿を防ぐ)。
            format!(
                "if(lt(T,{}),{},{})",
                fmt_num(kfs[0].0),
                fmt_num(kfs[0].1),
                expr
            )
        }
    }
}

/// キーフレーム列 (time, value) からステップ(左側キーフレームの値)の ffmpeg 式を生成する。
/// visible(0/1)用。最初以前は最初の値、最後以降は最後の値。
fn step_expr(kfs: &[(f64, f64)]) -> String {
    match kfs {
        [] => "0".to_string(),
        [(_, v)] => fmt_num(*v),
        _ => {
            let mut expr = fmt_num(kfs[kfs.len() - 1].1);
            for i in (0..kfs.len() - 1).rev() {
                let (_, v0) = kfs[i];
                let (t1, _) = kfs[i + 1];
                expr = format!("if(lt(T,{}),{},{})", fmt_num(t1), fmt_num(v0), expr);
            }
            expr
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::export::{
        AClip, ClipTransform, ExportInput, MosaicKeyframe, MosaicRegion, VideoCodec,
    };
    use crate::ffmpeg::probe::AssetKind;

    fn make_keyframe(time: f64, cx: f64, cy: f64, rotation: f64, visible: bool) -> MosaicKeyframe {
        MosaicKeyframe {
            time,
            cx,
            cy,
            w: 200.0,
            h: 120.0,
            rotation,
            visible,
        }
    }

    fn make_vclip() -> VClip {
        VClip {
            input_index: Some(0),
            start: 0.0,
            duration: 5.0,
            in_point: 0.0,
            speed: 1.0,
            opacity: 1.0,
            transform: ClipTransform {
                x: 0.0,
                y: 0.0,
                scale: 1.0,
                rotation: 0.0,
            },
            fade_in: 0.5,
            fade_out: 0.5,
            effects: vec![],
            text: None,
            asset_w: Some(640.0),
            asset_h: Some(360.0),
            is_image: false,
            mosaics: vec![],
        }
    }

    fn make_aclip() -> AClip {
        AClip {
            input_index: 0,
            start: 0.0,
            duration: 5.0,
            in_point: 0.0,
            speed: 1.0,
            volume: 1.0,
            fade_in: 0.0,
            fade_out: 0.0,
        }
    }

    fn make_mosaic_spec() -> ExportSpec {
        let mut vc = make_vclip();
        vc.mosaics = vec![MosaicRegion {
            id: "r0".to_string(),
            enabled: true,
            block_size: 16.0,
            keyframes: vec![
                make_keyframe(0.0, 200.0, 180.0, 0.0, true),
                make_keyframe(3.0, 440.0, 180.0, 40.0, false),
            ],
        }];
        ExportSpec {
            output_path: "out.mp4".to_string(),
            width: 640,
            height: 360,
            fps: 30.0,
            sample_rate: 44100,
            duration_sec: 5.0,
            video_codec: VideoCodec::H264,
            quality: 20.0,
            audio_bitrate_kbps: 192,
            inputs: vec![ExportInput {
                index: 0,
                path: "test1.mp4".to_string(),
                kind: AssetKind::Video,
            }],
            video_clips: vec![vc],
            audio_clips: vec![make_aclip()],
        }
    }

    #[test]
    fn piecewise_expr_single_keyframe_is_constant() {
        assert_eq!(piecewise_expr(&[(0.0, 200.0)]), "200");
        assert_eq!(piecewise_expr(&[(2.5, -3.5)]), "-3.5");
    }

    #[test]
    fn piecewise_expr_interpolates_and_holds() {
        let expr = piecewise_expr(&[(0.0, 200.0), (3.0, 440.0)]);
        // 最初以前は 200 でホールド、0..3 は線形補間、3 以降は 440 でホールド。
        assert_eq!(
            expr,
            "if(lt(T,0),200,if(lt(T,3),(200)+(240)*(T-(0))/(3),440))"
        );
    }

    #[test]
    fn piecewise_expr_three_keyframes_nests() {
        let expr = piecewise_expr(&[(0.0, 0.0), (1.0, 10.0), (4.0, 40.0)]);
        assert_eq!(
            expr,
            "if(lt(T,0),0,if(lt(T,1),(0)+(10)*(T-(0))/(1),if(lt(T,4),(10)+(30)*(T-(1))/(3),40)))"
        );
    }

    #[test]
    fn step_expr_holds_left_value() {
        assert_eq!(step_expr(&[(0.0, 1.0)]), "1");
        assert_eq!(step_expr(&[(0.0, 1.0), (3.0, 0.0)]), "if(lt(T,3),1,0)");
    }

    #[test]
    fn media_chain_uses_local_time_and_shifts_at_end() {
        let mut vc = make_vclip();
        vc.start = 2.0;
        let chain = build_media_clip_chain(&vc, 0, 0, "v0", 30.0);
        // ローカル時間チェーン: setpts はローカル化のみ(start シフトは末尾)。
        assert!(chain.contains("setpts=(PTS-STARTPTS)/1.000000, fps=30.000000"));
        // fade の st はクリップローカル(in: 0 / out: duration-fadeOut)。
        assert!(chain.contains("fade=t=in:st=0:d=0.500000:alpha=1"));
        assert!(chain.contains("fade=t=out:st=4.500000:d=0.500000:alpha=1"));
        // 最後にタイムライン位置へシフト。
        assert!(chain.contains("setpts=PTS+2.000000/TB [v0];"));
    }

    #[test]
    fn image_chain_uses_local_time_and_shifts_at_end() {
        let mut vc = make_vclip();
        vc.is_image = true;
        vc.start = 1.0;
        let chain = build_media_clip_chain(&vc, 0, 0, "v0", 30.0);
        assert!(chain.contains("trim=duration=5.000000, setpts=PTS-STARTPTS, fps=30.000000"));
        assert!(chain.contains("setpts=PTS+1.000000/TB [v0];"));
    }

    #[test]
    fn mosaic_chain_matches_prototype_structure() {
        let spec = make_mosaic_spec();
        let script = build_filter_complex(&spec);

        // split → pixelate → color → geq マスク → alphamerge → overlay の連鎖。
        assert!(script.contains("[v0p];"));
        assert!(script.contains("[v0p]split[v0m0o][v0m0x];"));
        assert!(script.contains(
            "[v0m0x]scale=ceil(iw/16):ceil(ih/16),scale=640:360:flags=neighbor,format=yuva420p[v0m0pix];"
        ));
        // マスクは 1/4 解像度(640x360 → 160x90)、r=fps、d=クリップローカル duration。
        assert!(script.contains("color=c=black:s=160x90:r=30.000000:d=5.000000[v0m0mb];"));
        assert!(script.contains("[v0m0mb]geq=lum='"));
        assert!(script.contains(":cb=128:cr=128,format=gray,scale=640:360[v0m0mask];"));
        assert!(script.contains("[v0m0pix][v0m0mask]alphamerge[v0m0pixa];"));
        assert!(script.contains("[v0m0o][v0m0pixa]overlay=0:0[v0m0out];"));
        // モザイク後に scale 以降の後段が続き、最後に [v0] へ。
        assert!(script.contains("[v0m0out] scale=w=iw*1.000000:h=ih*1.000000, format=yuva420p"));
        assert!(script.contains("setpts=PTS+0.000000/TB [v0];"));

        // geq 式: X/Y の 4 倍換算、回転(度→ラジアン)、区分線形 cx、visible ステップ。
        assert!(
            script.contains("st(0,X*4-(if(lt(T,0),200,if(lt(T,3),(200)+(240)*(T-(0))/(3),440))));")
        );
        // cy/w/h は両キーフレームで同値だが、2 個ある限り区分線形式になる(値は一定)。
        assert!(
            script.contains("st(1,Y*4-(if(lt(T,0),180,if(lt(T,3),(180)+(0)*(T-(0))/(3),180))));")
        );
        assert!(
            script.contains("st(4,(if(lt(T,0),0,if(lt(T,3),(0)+(40)*(T-(0))/(3),40)))*PI/180);")
        );
        assert!(script.contains("st(2,ld(0)*cos(ld(4))+ld(1)*sin(ld(4)));"));
        assert!(script.contains("st(3,-ld(0)*sin(ld(4))+ld(1)*cos(ld(4)));"));
        assert!(script.contains(
            "255*lt(abs(ld(2)),(if(lt(T,0),200,if(lt(T,3),(200)+(0)*(T-(0))/(3),200)))/2)\
             *lt(abs(ld(3)),(if(lt(T,0),120,if(lt(T,3),(120)+(0)*(T-(0))/(3),120)))/2)\
             *(if(lt(T,3),1,0))"
        ));

        // overlay の enable はタイムライン時刻のまま。
        assert!(script.contains("enable='between(t,0.000000,5.000000)'"));
        // 音声チェーンは従来通り。
        assert!(script.contains("[0:a] atrim=start=0.000000:end=5.000000, asetpts=PTS-STARTPTS"));
        assert!(script.contains("amix=inputs=1:normalize=0:duration=longest[aout]"));
    }

    #[test]
    fn mosaic_skipped_when_disabled_or_no_keyframes_or_no_asset_size() {
        // disabled
        let mut spec = make_mosaic_spec();
        spec.video_clips[0].mosaics[0].enabled = false;
        assert!(!build_filter_complex(&spec).contains("split"));

        // keyframes 空
        let mut spec = make_mosaic_spec();
        spec.video_clips[0].mosaics[0].keyframes.clear();
        assert!(!build_filter_complex(&spec).contains("split"));

        // assetW/assetH 不明
        let mut spec = make_mosaic_spec();
        spec.video_clips[0].asset_w = None;
        assert!(!build_filter_complex(&spec).contains("split"));
    }

    #[test]
    fn multiple_regions_chain_serially_with_unique_labels() {
        let mut spec = make_mosaic_spec();
        let mut second = spec.video_clips[0].mosaics[0].clone();
        second.id = "r1".to_string();
        second.block_size = 8.0;
        spec.video_clips[0].mosaics.push(second);
        let script = build_filter_complex(&spec);

        assert!(script.contains("[v0p]split[v0m0o][v0m0x];"));
        assert!(script.contains("[v0m0out]split[v0m1o][v0m1x];"));
        assert!(script.contains("[v0m1x]scale=ceil(iw/8):ceil(ih/8)"));
        assert!(script.contains("[v0m1out] scale=w=iw*"));
    }

    /// 実機スモークテスト用: `RVE_SMOKE_OUT` にフィルタスクリプトを書き出す。
    /// `cargo test -- --ignored smoke_generate_filter_script` を環境変数付きで実行する。
    #[test]
    #[ignore = "手動スモークテスト用(RVE_SMOKE_OUT へ filter script を書き出す)"]
    fn smoke_generate_filter_script() {
        let out = match std::env::var("RVE_SMOKE_OUT") {
            Ok(p) => p,
            Err(_) => return,
        };
        let script = build_filter_complex(&make_mosaic_spec());
        std::fs::write(&out, &script).expect("フィルタスクリプトの書き出しに失敗");
    }
}
