// Utility for getting a Bearer token for the braid public API.
// Paste into browser console, or load via <script src="/public/braid-api.js">
//
// Usage: console.log(JSON.stringify(await get_api_token()))

async function get_api_token() {
    var token = localStorage.getItem('hedgedoc-api-token')
    if (!token) {
        var csrf = await fetch('/api/private/csrf/token').then(r => r.json())
        var result = await fetch('/api/private/tokens', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', 'csrf-token': csrf.token},
            body: JSON.stringify({label: 'braid-editor', validUntil: '2027-01-01T00:00:00.000Z'})
        }).then(r => r.json())
        token = result.secret
        localStorage.setItem('hedgedoc-api-token', token)
    }
    return token
}
