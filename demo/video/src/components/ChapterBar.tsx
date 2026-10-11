import React from "react";
import {
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { COLORS, FONT } from "../styles";

/** lower-third 章节条：delay 帧后滑入，480 帧后淡出 */
export const ChapterBar: React.FC<{
  index: string;
  title: string;
  delay: number;
}> = ({ index, title, delay }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame - delay;
  const enter = spring({ frame: t, fps, config: { damping: 200 } });
  const exit = interpolate(frame, [440, 480], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <div
      style={{
        position: "absolute",
        left: 80,
        top: 96,
        display: "flex",
        alignItems: "center",
        gap: 18,
        opacity: enter * exit,
        transform: `translateX(${(1 - enter) * -60}px)`,
      }}
    >
      <div style={{ width: 6, height: 64, background: COLORS.accent }} />
      <div>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 26,
            color: COLORS.accent,
            letterSpacing: 4,
          }}
        >
          {index}
        </div>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 48,
            fontWeight: 700,
            color: COLORS.text,
          }}
        >
          {title}
        </div>
      </div>
    </div>
  );
};
