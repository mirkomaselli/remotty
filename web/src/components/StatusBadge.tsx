import type { SessionStatus } from '@remotty/shared';
import { STATUS_BADGE, STATUS_DOT, STATUS_LABEL } from '../lib/format';

export default function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_BADGE[status]}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[status]} ${
          status === 'running' ? 'animate-pulse' : ''
        }`}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}
