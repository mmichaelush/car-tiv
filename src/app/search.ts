/**
 * `/search` — the full catalog with every filter available.
 */

import { startPage } from './bootstrap.js';
import { catalog } from '../data/catalog-repository.js';
import { mountCatalogView } from '../features/catalog/catalog-view.js';
import { mountSearchBox } from '../ui/components/search-box.js';
import { select } from '../ui/dom.js';

startPage({ headerSearch: false });

const view = mountCatalogView({ root: select('[data-catalog]') });

mountSearchBox({
  form: select<HTMLFormElement>('[data-page-search]'),
  suggest: (query, signal) => catalog.suggest(query, signal),
  value: view.current().q,
  // Searching updates the results in place rather than navigating, so the
  // filters the visitor already set survive the search.
  onSubmit: (query) => {
    view.update({ q: query });
  },
});
