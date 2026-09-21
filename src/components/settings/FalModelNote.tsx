// The Fal pages are a curated catalog: the saved model id alone says nothing
// about what that model accepts, so the page prints the selected entry's
// constraints under the fields.
import { FAL_MODELS, falModelSummary } from '../../../shared/fal-models';
import { pageNote } from './settingsVendorPane.styles';
import { modelValue, type KeyStatusResponse, type SettingsVendorPage, type StagedValues } from './settingsSchema';

export function FalModelNote({ page, status, values }: {
  page: SettingsVendorPage;
  status: KeyStatusResponse | null;
  values: StagedValues;
}) {
  if (page.vendor !== 'fal') return null;
  const field = page.key === 'image/fal' ? 'FAL_IMAGE_MODEL' : 'FAL_VIDEO_MODEL';
  const model = FAL_MODELS.find((entry) => entry.id === (values[field] ?? modelValue(status, field)));
  return model ? <div style={pageNote}>{falModelSummary(model)}</div> : null;
}
