import { PanelPlugin } from '@grafana/data';
import { SimpleOptions } from './types';
import { LimoPanel } from './components/LimoPanel';

export const plugin = new PanelPlugin<SimpleOptions>(LimoPanel);
