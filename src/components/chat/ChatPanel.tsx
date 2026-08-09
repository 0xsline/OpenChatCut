import { ChatPanelView } from './ChatPanelView';
import { useChatPanelController, type ChatPanelProps } from './chatPanelController';

/** Compose chat state and hand presentation to same-domain view components. */
export function ChatPanel(props: ChatPanelProps) {
  const controller = useChatPanelController(props);
  return <ChatPanelView controller={controller} />;
}
