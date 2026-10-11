import React from "react";
import { AbsoluteFill, staticFile, Video } from "remotion";
import { COLORS, FONT } from "../styles";

/**
 * 素材视频的安全封装：文件缺失时渲染暗底提示而非崩溃。
 * staticFile 对不存在文件在打包时抛错 → try/catch 探测；存在则透传渲染。
 * speed: 倍速快放（6 = 6×）; startFrom: 从素材第几帧起播。
 */
export const SafeVideo: React.FC<{
  src: string;
  speed?: number;
  startFrom?: number;
}> = ({ src, speed = 1, startFrom = 0 }) => {
  let exists = false;
  try {
    exists = !!staticFile(src);
  } catch {
    exists = false;
  }
  if (!exists) {
    return (
      <AbsoluteFill
        style={{
          background: COLORS.bg,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <div style={{ fontFamily: FONT, fontSize: 40, color: COLORS.dim }}>
          [ 素材待录制: {src} ]
        </div>
      </AbsoluteFill>
    );
  }
  return (
    <Video
      src={staticFile(src)}
      playbackRate={speed}
      trimBefore={startFrom}
      muted
    />
  );
};
