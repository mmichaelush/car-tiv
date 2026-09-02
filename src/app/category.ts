/**
 * `/category/:id` — one category, with the rest of the filters still available.
 *
 * The category comes from the path, not from a query parameter, and the view
 * pins it so nothing in the UI can change it. The chip row is hidden: on a
 * category page it would just be a second, competing navigation.
 */

import { startPage } from './bootstrap.js';
import { catalog } from '../data/catalog-repository.js';
import { mountCatalogView } from '../features/catalog/catalog-view.js';
import { mountBreadcrumbs } from '../ui/components/breadcrumbs.js';
import { formatCount, select, setHtml, html } from '../ui/dom.js';
import { ROUTES } from '@shared/core/paths.js';

startPage();

/** `/category/maintenance` -> `maintenance`. */
const categoryId = decodeURIComponent(window.location.pathname.split('/').filter(Boolean)[1] ?? '');

const title = select('[data-category-title]');
const description = select('[data-category-description]');

mountCatalogView({
  root: select('[data-catalog]'),
  fixed: { category: categoryId },
  showCategories: false,
  onLoaded: (meta) => {
    // Singular and plural read very differently in Hebrew, and "1 סרטונים"
    // is the kind of detail that makes a site feel unfinished.
    setHtml(
      select('[data-page-subtitle]'),
      meta.total === 1
        ? html`נמצא <strong>סרטון אחד</strong> בקטגוריה זו.`
        : html`בקטגוריה זו קיימים <strong>${formatCount(meta.total)}</strong> סרטונים.`,
    );
  },
});

void catalog
  .listCategories()
  .then((categories) => {
    const category = categories.find((item) => item.id === categoryId);
    if (category == null) {
      title.textContent = 'הקטגוריה לא נמצאה';
      description.textContent = 'ייתכן שהקטגוריה הוסרה או שהכתובת שגויה.';
      return;
    }
    title.textContent = category.name;
    description.textContent = category.description;
    document.title = `${category.name} | CAR־טיב`;
    mountBreadcrumbs(select('[data-breadcrumbs]'), [
      { label: 'דף הבית', href: ROUTES.home },
      { label: category.name },
    ]);
  })
  .catch(() => {
    title.textContent = 'קטגוריה';
  });
