import { EditorWorkspaceView } from './editor/EditorWorkspaceView';
import { useEditorController, type EditorProps } from './editor/useEditorController';

export default function Editor(props: EditorProps) {
  const workspace = useEditorController(props);
  return <EditorWorkspaceView {...workspace} />;
}
