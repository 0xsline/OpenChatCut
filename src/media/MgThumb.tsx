// 素材池 MG 卡缩略图:agent 生成的 motion-graphic 素材只有代码没有预览图
// (资源库模板卡自带预览图,池内自定义 MG 没有),这里把 code 现场
// compileTemplate 后渲一个迷你 Remotion Player——静止在中帧(标题类动画
// 中帧才有字),悬停播放、移开回中帧。编译失败回落星形占位(与旧观感一致)。
import { useMemo, useRef } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { compileTemplate } from '../template-host';
import type { MediaAsset } from '../editor/types';
import { Icon } from '../components/icons';

interface MgThumbProps {
  asset: MediaAsset;
  fps: number;
}

export function MgThumb({ asset, fps }: MgThumbProps) {
  const playerRef = useRef<PlayerRef | null>(null);
  const compiled = useMemo(() => {
    if (!asset.code) return null;
    try {
      return compileTemplate(asset.code);
    } catch {
      return null; // 坏代码不炸卡片,回落占位
    }
  }, [asset.code]);

  if (!compiled) {
    return <Icon name="sparkles" size={42} strokeWidth={2.2} />;
  }

  const dw = asset.width ?? 1920;
  const dh = asset.height ?? 1080;
  const duration = Math.max(1, asset.durationInFrames || 60);
  const mid = Math.floor(duration / 2);
  const Template = compiled;

  return (
    <div
      style={{ width: '100%', height: '100%' }}
      onMouseEnter={() => playerRef.current?.play()}
      onMouseLeave={() => { playerRef.current?.pause(); playerRef.current?.seekTo(mid); }}
    >
      <Player
        ref={playerRef}
        component={Template}
        inputProps={{ item: { props: asset.props ?? {}, width: dw, height: dh } }}
        durationInFrames={duration}
        compositionWidth={dw}
        compositionHeight={dh}
        fps={fps}
        initialFrame={mid}
        loop
        controls={false}
        clickToPlay={false}
        // 点击穿透给卡片按钮(加到时间线);悬停事件由外层 div 接
        style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
        acknowledgeRemotionLicense
      />
    </div>
  );
}
