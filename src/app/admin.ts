/**
 * `/admin/` — the management area.
 *
 * The screens are built from the same design system as the public site, and
 * every action goes through `/api/admin/*`, which requires an authenticated
 * session with an `admin`, `editor` or `moderator` role. Nothing here is
 * reachable by knowing the URL.
 */

import { startPage } from './bootstrap.js';
import { mountAdmin } from '../features/admin/admin-app.js';
import { select } from '../ui/dom.js';

startPage({ headerSearch: false });

mountAdmin(select('[data-admin-root]'));
