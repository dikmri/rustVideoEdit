// タイムライン本体のプレースホルダ。P3 が Ruler/TrackHeader/TrackLane/ClipView/TimelineToolbar
// を含む本実装に置き換える(DESIGN.md §2, §9)。
import { useTranslation } from "react-i18next";

export function Timeline(): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="timeline-placeholder">
      <span className="text-sub">{t("timeline.placeholder")}</span>
    </div>
  );
}
