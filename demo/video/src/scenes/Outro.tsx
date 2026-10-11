import React from "react";
import { AbsoluteFill } from "remotion";
import { COLORS, FONT } from "../styles";
import { Fade } from "../components/Fade";

/** 片尾 8s：GitHub 地址 + aulos 制作声明 + CC0 素材出处 */
export const Outro: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        background: COLORS.bg,
        justifyContent: "center",
        alignItems: "center",
        gap: 28,
      }}
    >
      <Fade inF={5} outF={235} duration={15}>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 88,
            fontWeight: 700,
            color: COLORS.text,
          }}
        >
          aulos
        </div>
        <div style={{ fontFamily: FONT, fontSize: 40, color: COLORS.accent }}>
          github.com/your-name/aulos
        </div>
        <div style={{ fontFamily: FONT, fontSize: 34, color: COLORS.dim }}>
          本视频由 aulos 编写脚本并剪辑
        </div>
        <div
          style={{
            fontFamily: FONT,
            fontSize: 20,
            color: COLORS.dim,
            marginTop: 40,
          }}
        >
          BGM &amp; SFX: FreePD / Kenney (CC0)
        </div>
      </Fade>
    </AbsoluteFill>
  );
};
