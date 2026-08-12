export type MediaView = 'grid' | 'list';

export function toggleMediaView(view: MediaView): MediaView {
  return view === 'grid' ? 'list' : 'grid';
}

export function mediaViewToggleLabel(view: MediaView): '切换到网格视图' | '切换到列表视图' {
  return view === 'grid' ? '切换到列表视图' : '切换到网格视图';
}
