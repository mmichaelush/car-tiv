/**
 * `/contact/` — the general contact form.
 *
 * Posts to our own API, which opens a thread in the admin inbox. The old site
 * posted to a Google Apps Script endpoint; messages now live in the same place
 * as reports and suggestions, where they can actually be answered and tracked.
 *
 * The direct email address stays on the page as the fallback, and the page
 * pre-fills it with whatever the visitor typed if a send fails — losing a
 * written-out message to a failed request is the one outcome worth engineering
 * against.
 */

import { startPage } from './bootstrap.js';
import { engagement } from '../data/engagement-repository.js';
import { field, mountForm, optionalField } from './forms.js';
import { mailtoUrl, select } from '../ui/dom.js';
import { SITE_EMAIL } from '../ui/layout/shell.js';

startPage({ active: 'contact' });

const form = select<HTMLFormElement>('[data-contact-form]');

// `?subject=…` lets a link elsewhere on the site open this form with the
// subject already filled in — the footer's "report content" link does exactly
// that, which is how the legacy site's report link behaved.
const requestedSubject = new URLSearchParams(window.location.search).get('subject');
if (requestedSubject != null && requestedSubject.length > 0) {
  const subject = form.querySelector<HTMLInputElement>('[name="subject"]');
  if (subject != null) subject.value = requestedSubject;
}

mountForm({
  form,
  successMessage: 'ההודעה נשלחה',
  onServerFailure: () => {
    // Turn the address in the sidebar into a pre-filled mailto, so the message
    // the visitor already wrote is not lost to an outage of ours.
    const link = document.querySelector<HTMLAnchorElement>('[data-contact-mailto]');
    if (link == null) return;

    const data = new FormData(form);
    link.href = mailtoUrl(SITE_EMAIL, {
      subject: optionalField(data, 'subject') ?? 'פנייה מאתר CAR־טיב',
      body: field(data, 'message'),
    });
    link.closest('li')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },
  submit: async (data) => {
    await engagement.contact({
      name: field(data, 'name'),
      email: field(data, 'email'),
      subject: optionalField(data, 'subject'),
      message: field(data, 'message'),
      // Read from the control rather than assumed: the form is `novalidate`,
      // so the browser does not enforce `required` for us and the server has
      // to be told the truth.
      acceptedPrivacy: data.get('acceptedPrivacy') != null,
    });
  },
});
