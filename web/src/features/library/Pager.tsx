import { useId } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useLimits } from '../../api/queries';
import { pageList, pageSizes, withPage, type PageSize } from '../../lib/paging';
import { cx } from '../../ui/Button';
import { Select } from '../../ui/Select';

interface PagerProps {
  page: number;
  pageCount: number;
  /** Where the page starts in the list, how many items it shows, and how many there are. */
  offset: number;
  shown: number;
  total: number;
  pageSize: PageSize;
  onPageSize: (size: PageSize) => void;
}

/**
 * The bar under the list, kept together on its right: which items this page
 * shows, how many a page holds, then the pages. Each page is a link to the same view with its
 * `page=`, so it can be opened in a new tab, and back and forward move
 * between pages.
 */
export function Pager({ page, pageCount, offset, shown, total, pageSize, onPageSize }: PagerProps) {
  const [searchParams] = useSearchParams();
  const sizeId = useId();
  const limits = useLimits();
  const to = (n: number) => ({ search: withPage(searchParams, n).toString() });
  // Previous and Next; at either end, a disabled button in the link's place.
  const step = (n: number, next: boolean) => {
    const label = next ? 'Next page' : 'Previous page';
    const icon = next ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronLeft size={16} aria-hidden="true" />;
    return n < 1 || n > pageCount ? (
      <button type="button" className="pager-btn" aria-label={label} disabled>
        {icon}
      </button>
    ) : (
      <Link className="pager-btn" to={to(n)} rel={next ? 'next' : 'prev'} aria-label={label} title={label}>
        {icon}
      </Link>
    );
  };
  return (
    <div className="pager">
      <div className="pager-info">
        <span className="pager-range">
          Showing <strong>{total === 0 ? 0 : offset + 1}–{offset + shown}</strong> of <strong>{total}</strong>
        </span>
        <Select
          id={sizeId}
          name="page-size"
          className="input-sm pager-size"
          value={String(pageSize)}
          onChange={(v) => onPageSize(Number(v) as PageSize)}
          options={pageSizes(limits?.maxPageSize).map((n) => ({ value: String(n), label: String(n) }))}
        />
        <label htmlFor={sizeId}>per page</label>
      </div>
      <nav className="pager-pages" aria-label="Pages">
        {step(page - 1, false)}
        {pageList(page, pageCount).map((n, i) =>
          n === 'gap' ? (
            <span key={`gap-${i}`} className="pager-gap" aria-hidden="true">
              …
            </span>
          ) : (
            <Link key={n} className={cx('pager-btn', n === page && 'is-current')} to={to(n)} aria-current={n === page ? 'page' : undefined} aria-label={`Page ${n}`}>
              {n}
            </Link>
          ),
        )}
        {step(page + 1, true)}
      </nav>
    </div>
  );
}
