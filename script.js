document.addEventListener('DOMContentLoaded', () => {
    const themeToggle = document.getElementById('theme-toggle');
    const body = document.body;
    const header = document.querySelector('header');
    const cards = document.querySelectorAll('.card');
    const searchInput = document.getElementById('search-input');

    // Função para alternar o tema
    function toggleTheme() {
        body.classList.toggle('light-mode');
        header.classList.toggle('light-mode');
        cards.forEach(card => card.classList.toggle('light-mode'));
        themeToggle.textContent = body.classList.contains('light-mode') ? '🌙' : '☀️';
    }

    // Evento de clique para alternar o tema
    themeToggle.addEventListener('click', toggleTheme);

    // Função para filtrar os cards
    function filterDisciplines() {
        const searchTerm = searchInput.value.toLowerCase();
        cards.forEach(card => {
            const title = card.querySelector('h3').textContent.toLowerCase();
            const keywords = card.dataset.keywords.toLowerCase();
            if (title.includes(searchTerm) || keywords.includes(searchTerm)) {
                card.style.display = 'block';
            } else {
                card.style.display = 'none';
            }
        });
    }

    // Evento de input para a busca
    searchInput.addEventListener('input', filterDisciplines);
});