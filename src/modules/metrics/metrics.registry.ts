import { Registry } from 'prom-client';
import {
  METRICS_REGISTRY,
  type MetricsRegistryProvider,
} from './metrics.constants';

export const metricsRegistryProvider: MetricsRegistryProvider = {
  provide: METRICS_REGISTRY,
  useFactory: () => new Registry(),
};
