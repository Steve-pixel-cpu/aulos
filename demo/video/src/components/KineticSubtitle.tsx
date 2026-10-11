import React from "react";
import { spring, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS, FONT } from "../styles";

/** 逐字弹出字幕：lines 逐行、每字符间隔 perWord 帧 spring 入场 */
export const KineticSubtitle: React.FC<{
  lines: string[];
  startFrame: number;
  perWord?: number;
}> = ({ lines, startFrame, perWord = 3 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const chars = lines.flatMap((line) => line.split(""));
  return (
    <div
      style={{
        position: "absolute",
        bottom: 90,
        width: "100%",
        textAlign: "center",
      }}
    >
      {chars.map((ch, i) => {
        const t = frame - startFrame - i * perWord;
        const appear = spring({ frame: t, fps, config: { damping: 200 } });
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity: appear,
              transform: `translateY(${(1 - appear) * 14}px)`,
              fontFamily: FONT,
              fontSize: 44,
              fontWeight: 600,
              color: COLORS.text,
              textShadow: "0 2px 12px rgba(0,0,0,.8)",
              whiteSpace: "pre",
            }}
          >
            {ch}
          </span>
        );
      })}
    </div>
  );
};
