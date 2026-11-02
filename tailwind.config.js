module.exports = {
    content: ['./index.html', './script.js'],
    theme: {
        extend: {
            fontFamily: {
                sans: ['Inter', 'sans-serif'],
                serif: ['Playfair Display', 'serif']
            },
            colors: {
                brand: {
                    dark: '#0f172a',
                    navy: '#1e3a8a',
                    blue: '#2563eb',
                    light: '#f8fafc',
                    accent: '#3b82f6'
                }
            }
        }
    }
};
