document
  .getElementById("upload-form")
  .addEventListener("submit", async (event) => {
    event.preventDefault();

    const fileInput = document.getElementById("file-input");
    const formData = new FormData();
    formData.append("file", fileInput.files[0]);

    // Показуємо індикатор завантаження
    document.getElementById("loading-indicator").style.display = "block";

    try {
      const response = await fetch("/parse", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (data.error) {
        alert(data.error);
        return;
      }

      displayResults(data.results);
    } catch (error) {
      console.error("Error:", error);
      alert("Сталася помилка при завантаженні файлу.");
    } finally {
      // Сховуємо індикатор завантаження після отримання результатів
      document.getElementById("loading-indicator").style.display = "none";
    }
  });

function displayResults(results) {
  const resultsContainer = document.getElementById("results-container");
  resultsContainer.innerHTML = "";

  results.forEach((result) => {
    const resultDiv = document.createElement("div");
    resultDiv.classList.add("result");

    let content = `<strong>${result.name}</strong><br/>`;

    // Перебираємо результати для кожного сайту
    result.results.forEach((siteResult) => {
      content += `<span class="site-name">${siteResult.site}:</span><br/>`;
      content += `Назва товару: ${siteResult.name}<br/>`;  // Добавлен вывод названия
      content += `Ціна: ${siteResult.price}<br/>`;
      content += `<a href="${siteResult.link}" target="_blank">Посилання на товар</a><br/><br/>`;
    });
    

    resultDiv.innerHTML = content;
    resultsContainer.appendChild(resultDiv);
  });
}
