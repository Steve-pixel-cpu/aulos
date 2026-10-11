import React from "react";
import {
  AbsoluteFill,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { COLORS, FONT } from "../styles";
import { Fade } from "../components/Fade";
import { KineticSubtitle } from "../components/KineticSubtitle";

/** 片头 8s：终端光标闪烁 0-90 帧 → logo spring 弹出 → slogan 逐字 */
export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cursorOn = Math.floor(frame / 15) % 2 === 0;
  const logo = spring({ frame: frame - 90, fps, config: { damping: 12 } });
  return (
    <AbsoluteFill
      style={{
        background: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      <Fade inF={0} outF={235} duration={12}>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 64,
            color: COLORS.dim,
            opacity: frame < 90 ? 1 : 0,
          }}
        >
          ${" "}
          <span style={{ opacity: cursorOn ? 1 : 0 }}>▊</span>
        </div>
        <div
          style={{
            fontFamily: FONT,
            fontWeight: 700,
            fontSize: 140,
            color: COLORS.text,
            opacity: logo,
            transform: `scale(${0.92 + logo * 0.08})`,
            letterSpacing: -2,
          }}
        >
          aulos<span style={{ color: COLORS.accent }}>.</span>
        </div>
        <KineticSubtitle lines={["让 AI 替你干活"]} startFrame={130} perWord={6} />
      </Fade>
    </AbsoluteFill>
  );
};
