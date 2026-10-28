import React, { useCallback, useEffect, useState } from 'react';
import { Edit3, Plus, Trash2, Upload } from 'lucide-react';
import { PRODUCT_CATEGORIES, PRODUCT_USAGES } from '../shared/types';
import type { ProductAdminView, ProductCategory, ProductUsage } from '../shared/types';
import { adminApi, readImageFileAsDataUrl } from '../lib/api';
import { ConfirmDialog, EmptyStateBox, InlineAlert, ProductVisual } from '../components/Branding';

export function AdminProductsSection({ onDataChanged }: { onDataChanged: () => void }) {
  const [products, setProducts] = useState<ProductAdminView[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ tone: 'success' | 'error' | 'info'; message: string } | null>(null);

  // Add / Edit Modal
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<ProductAdminView | null>(null);
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ProductCategory>('BRB Cattle Feed');
  const [packingWeight, setPackingWeight] = useState('40 kg Bag');
  const [usage, setUsage] = useState<ProductUsage>('Both');
  const [shortDescription, setShortDescription] = useState('');
  const [fullDetails, setFullDetails] = useState('');
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  // Delete / Archive Dialog
  const [deleteTarget, setDeleteTarget] = useState<ProductAdminView | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi<{ products: ProductAdminView[] }>(
        `/api/admin/products${includeArchived ? '?includeArchived=1' : ''}`
      );
      setProducts(res.products);
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Unable to load product catalog.',
      });
    } finally {
      setLoading(false);
    }
  }, [includeArchived]);

  useEffect(() => {
    void loadProducts();
  }, [loadProducts]);

  const openCreateEditor = () => {
    setEditingProduct(null);
    setName('');
    setCategory('BRB Cattle Feed');
    setPackingWeight('40 kg Bag');
    setUsage('Both');
    setShortDescription('');
    setFullDetails('');
    setImageUrl(null);
    setIsActive(true);
    setEditorOpen(true);
  };

  const openEditEditor = (prod: ProductAdminView) => {
    setEditingProduct(prod);
    setName(prod.name);
    setCategory(prod.category);
    setPackingWeight(prod.packingWeight);
    setUsage(prod.usage);
    setShortDescription(prod.shortDescription);
    setFullDetails(prod.fullDetails);
    setImageUrl(prod.imageUrl);
    setIsActive(prod.isActive);
    setEditorOpen(true);
  };

  const handleImageFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await readImageFileAsDataUrl(file);
      setImageUrl(dataUrl);
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Invalid image file.',
      });
    }
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setBanner(null);
    try {
      const payload = {
        name: name.trim(),
        category,
        packingWeight: packingWeight.trim(),
        usage,
        shortDescription: shortDescription.trim(),
        fullDetails: fullDetails.trim() || shortDescription.trim(),
        imageUrl,
        isActive,
      };
      if (editingProduct) {
        await adminApi(`/api/admin/products/${editingProduct.id}`, {
          method: 'PUT',
          body: payload,
        });
        setBanner({ tone: 'success', message: `Updated product "${payload.name}".` });
      } else {
        await adminApi('/api/admin/products', {
          method: 'POST',
          body: payload,
        });
        setBanner({ tone: 'success', message: `Added product "${payload.name}" to BRB catalog.` });
      }
      setEditorOpen(false);
      await loadProducts();
      onDataChanged();
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Failed to save product.',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (prod: ProductAdminView) => {
    setBanner(null);
    try {
      await adminApi(`/api/admin/products/${prod.id}`, {
        method: 'PUT',
        body: { isActive: !prod.isActive },
      });
      await loadProducts();
      setBanner({
        tone: 'info',
        message: !prod.isActive
          ? `"${prod.name}" is now Active and available for customer ordering.`
          : `"${prod.name}" is now Deactivated (shown as Currently Unavailable to customers).`,
      });
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Failed to toggle product availability.',
      });
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setBanner(null);
    try {
      const res = await adminApi<{ mode: 'deleted' | 'archived'; message: string }>(
        `/api/admin/products/${deleteTarget.id}`,
        { method: 'DELETE' }
      );
      setDeleteTarget(null);
      await loadProducts();
      setBanner({ tone: 'info', message: res.message });
    } catch (err) {
      setBanner({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Delete/Archive failed.',
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-extrabold text-slate-950">
            Product Catalog Management
          </h1>
          <p className="text-xs sm:text-sm text-slate-600 mt-0.5">
            Manage BRB Cattle Feed and BRB Oil Mill lines. Customer-facing product screens never
            display prices.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-slate-900"
            />
            <span>Show Archived</span>
          </label>

          <button
            type="button"
            onClick={openCreateEditor}
            className="min-h-[42px] inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" />
            Add Product
          </button>
        </div>
      </div>

      {banner && (
        <InlineAlert
          tone={banner.tone}
          message={banner.message}
          onDismiss={() => setBanner(null)}
        />
      )}

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-xs text-slate-500">
          Loading BRB product catalog...
        </div>
      ) : products.length === 0 ? (
        <EmptyStateBox
          title="No Products in Catalog Yet"
          description="Add official BRB Cattle Feed or BRB Oil Mill products so customers can browse and place orders."
          actionLabel="Add First Product"
          onAction={openCreateEditor}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {products.map((prod) => (
            <article
              key={prod.id}
              className="rounded-xl border border-slate-200 bg-white overflow-hidden flex flex-col justify-between"
            >
              <div>
                <ProductVisual
                  imageUrl={prod.imageUrl}
                  name={prod.name}
                  category={prod.category}
                  isActive={prod.isActive && !prod.isArchived}
                  className="h-40 w-full border-b border-slate-100"
                />
                <div className="p-4">
                  <p className="text-xs text-slate-500">
                    {prod.category} · {prod.packingWeight} · Usage: {prod.usage}
                  </p>
                  <h2 className="mt-1 text-base font-bold text-slate-950">{prod.name}</h2>
                  <p className="mt-1 text-xs text-slate-600 line-clamp-2">
                    {prod.shortDescription}
                  </p>
                  <p className="mt-2 text-xs">
                    {prod.isArchived ? (
                      <span className="font-semibold text-slate-500">Archived (Historical)</span>
                    ) : prod.isActive ? (
                      <span className="font-semibold text-emerald-700">Active (Orderable)</span>
                    ) : (
                      <span className="font-semibold text-rose-700">
                        Deactivated (Currently Unavailable)
                      </span>
                    )}
                  </p>
                </div>
              </div>

              {!prod.isArchived && (
                <div className="px-4 pb-4 pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => void handleToggleActive(prod)}
                    className="min-h-[36px] px-3 py-1 rounded-lg border border-slate-300 text-xs font-semibold text-slate-800 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0"
                  >
                    {prod.isActive ? 'Deactivate' : 'Activate'}
                  </button>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      aria-label={`Edit ${prod.name}`}
                      onClick={() => openEditEditor(prod)}
                      className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete or archive ${prod.name}`}
                      onClick={() => setDeleteTarget(prod)}
                      className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {/* Add / Edit Product Modal */}
      {editorOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={editingProduct ? 'Edit Product' : 'Add Product'}
          className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/50 backdrop-blur-xs p-4 flex items-center justify-center"
        >
          <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-xl my-8">
            <h2 className="text-lg font-extrabold text-slate-950">
              {editingProduct ? `Edit Product: ${editingProduct.name}` : 'Add BRB Product'}
            </h2>

            <form onSubmit={handleSaveProduct} className="mt-4 space-y-4">
              <div>
                <label
                  htmlFor="prod-name"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Product Name *
                </label>
                <input
                  id="prod-name"
                  type="text"
                  required
                  placeholder="Enter official BRB product name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label
                    htmlFor="prod-category"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Category *
                  </label>
                  <select
                    id="prod-category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value as ProductCategory)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900"
                  >
                    {PRODUCT_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="prod-packing"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Packing / Weight *
                  </label>
                  <input
                    id="prod-packing"
                    type="text"
                    required
                    placeholder="e.g., 40 kg Bag"
                    value={packingWeight}
                    onChange={(e) => setPackingWeight(e.target.value)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-900"
                  />
                </div>

                <div>
                  <label
                    htmlFor="prod-usage"
                    className="block text-xs font-semibold text-slate-700 mb-1"
                  >
                    Usage *
                  </label>
                  <select
                    id="prod-usage"
                    value={usage}
                    onChange={(e) => setUsage(e.target.value as ProductUsage)}
                    className="w-full min-h-[42px] rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900"
                  >
                    {PRODUCT_USAGES.map((u) => (
                      <option key={u} value={u}>
                        {u}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label
                  htmlFor="prod-short-desc"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Brief Description *
                </label>
                <input
                  id="prod-short-desc"
                  type="text"
                  required
                  maxLength={300}
                  placeholder="Concise summary displayed on product cards"
                  value={shortDescription}
                  onChange={(e) => setShortDescription(e.target.value)}
                  className="w-full min-h-[42px] rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                />
              </div>

              <div>
                <label
                  htmlFor="prod-full-details"
                  className="block text-xs font-semibold text-slate-700 mb-1"
                >
                  Full Product Details &amp; Feeding Notes
                </label>
                <textarea
                  id="prod-full-details"
                  rows={3}
                  placeholder="Detailed nutritional / usage specifications"
                  value={fullDetails}
                  onChange={(e) => setFullDetails(e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900"
                />
              </div>

              {/* Image Upload */}
              <div>
                <span className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Product Image (PNG / JPG / WebP)
                </span>
                <div className="flex items-center gap-4">
                  <ProductVisual
                    imageUrl={imageUrl}
                    name={name || 'Product'}
                    category={category}
                    className="h-20 w-24 rounded-xl border border-slate-200 shrink-0"
                  />
                  <div className="space-y-2">
                    <label className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer">
                      <Upload className="h-3.5 w-3.5" />
                      <span>Upload Image</span>
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        onChange={handleImageFileSelect}
                        className="sr-only"
                      />
                    </label>
                    {imageUrl && (
                      <button
                        type="button"
                        onClick={() => setImageUrl(null)}
                        className="block text-xs font-semibold text-rose-700 hover:underline"
                      >
                        Remove Uploaded Image
                      </button>
                    )}
                  </div>
                </div>
              </div>

              <label className="flex items-center gap-2.5 text-xs font-semibold text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300 text-slate-900"
                />
                <span>Active &amp; available for customer ordering</span>
              </label>

              <div className="pt-3 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setEditorOpen(false)}
                  className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="min-h-[42px] px-5 py-2 rounded-lg bg-slate-900 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : editingProduct ? 'Save Changes' : 'Create Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={`Remove "${deleteTarget?.name || 'Product'}"?`}
        description="If this product is referenced by historical orders or invoices, it will be safely archived instead of deleted so accounting records remain intact."
        confirmLabel="Delete / Archive"
        destructive
        busy={deleting}
        onConfirm={() => void handleConfirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
