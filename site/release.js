const releaseMetadataUrl = new URL('./release.json', document.baseURI)

fetch(releaseMetadataUrl)
	.then(response => {
		if (!response.ok)
			throw new Error('Release metadata is not available yet.')
		return response.json()
	})
	.then(release => {
		if (typeof release.version === 'string') {
			for (const element of document.querySelectorAll(
				'[data-release-version]',
			)) {
				element.textContent = `v${release.version}`
			}
		}

		if (typeof release.download === 'string') {
			for (const link of document.querySelectorAll('a[data-download]')) {
				link.href = new URL(release.download, document.baseURI).href
				link.setAttribute('download', '')
			}
		}
	})
	.catch(() => {
		// The source checkout includes a stable GitHub download fallback in the HTML.
	})
