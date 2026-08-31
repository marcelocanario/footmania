import { addLocale, locale as setPrimeLocale } from "primereact/api";
import type { Lang } from "./languages";

function names(lang: Lang, kind: "weekday" | "month", width: "long" | "short" | "narrow"): string[] {
  const formatter = new Intl.DateTimeFormat(lang, { [kind]: width, timeZone: "UTC" });
  const start = kind === "weekday" ? Date.UTC(2024, 0, 7) : Date.UTC(2024, 0, 1);
  const count = kind === "weekday" ? 7 : 12;
  const step = kind === "weekday" ? 86_400_000 : undefined;
  return Array.from({ length: count }, (_, index) => {
    const at = step === undefined ? Date.UTC(2024, index, 1) : start + index * step;
    return formatter.format(new Date(at));
  });
}

function bundle(lang: Lang) {
  const weekdays = names(lang, "weekday", "long");
  const weekdaysShort = names(lang, "weekday", "short");
  const weekdaysMin = names(lang, "weekday", "narrow");
  const months = names(lang, "month", "long");
  const monthsShort = names(lang, "month", "short");
  return {
    firstDayOfWeek: 1,
    dayNames: weekdays,
    dayNamesShort: weekdaysShort,
    dayNamesMin: weekdaysMin,
    monthNames: months,
    monthNamesShort: monthsShort,
    today: lang === "fr" ? "Aujourd'hui" : lang === "pt-BR" ? "Hoje" : "Today",
    clear: lang === "fr" ? "Effacer" : lang === "pt-BR" ? "Limpar" : "Clear",
    accept: lang === "fr" ? "Accepter" : lang === "pt-BR" ? "Aceitar" : "Accept",
    reject: lang === "fr" ? "Refuser" : lang === "pt-BR" ? "Recusar" : "Reject",
    choose: lang === "fr" ? "Choisir" : lang === "pt-BR" ? "Escolher" : "Choose",
    upload: lang === "fr" ? "Téléverser" : lang === "pt-BR" ? "Enviar" : "Upload",
    cancel: lang === "fr" ? "Annuler" : lang === "pt-BR" ? "Cancelar" : "Cancel",
    emptyFilterMessage: lang === "fr" ? "Aucun résultat" : lang === "pt-BR" ? "Nenhum resultado" : "No results found",
    emptyMessage: lang === "fr" ? "Aucune option" : lang === "pt-BR" ? "Nenhuma opção" : "No options",
    aria: {
      trueLabel: lang === "fr" ? "vrai" : lang === "pt-BR" ? "verdadeiro" : "true",
      falseLabel: lang === "fr" ? "faux" : lang === "pt-BR" ? "falso" : "false",
      nullLabel: lang === "fr" ? "non sélectionné" : lang === "pt-BR" ? "não selecionado" : "not selected",
      pageLabel: lang === "fr" ? "Page" : lang === "pt-BR" ? "Página" : "Page",
      firstPageLabel: lang === "fr" ? "Première page" : lang === "pt-BR" ? "Primeira página" : "First Page",
      lastPageLabel: lang === "fr" ? "Dernière page" : lang === "pt-BR" ? "Última página" : "Last Page",
      nextPageLabel: lang === "fr" ? "Page suivante" : lang === "pt-BR" ? "Próxima página" : "Next Page",
      prevPageLabel: lang === "fr" ? "Page précédente" : lang === "pt-BR" ? "Página anterior" : "Previous Page",
      rowsPerPageLabel: lang === "fr" ? "Lignes par page" : lang === "pt-BR" ? "Linhas por página" : "Rows per page",
      jumpToPageDropdownLabel: lang === "fr" ? "Aller à la page" : lang === "pt-BR" ? "Ir para a página" : "Jump to page dropdown",
      jumpToPageInputLabel: lang === "fr" ? "Aller à la page" : lang === "pt-BR" ? "Ir para a página" : "Jump to page input",
      selectRow: lang === "fr" ? "Sélectionner la ligne" : lang === "pt-BR" ? "Selecionar linha" : "Select row",
      unselectRow: lang === "fr" ? "Désélectionner la ligne" : lang === "pt-BR" ? "Desmarcar linha" : "Unselect row",
      expandRow: lang === "fr" ? "Développer la ligne" : lang === "pt-BR" ? "Expandir linha" : "Expand row",
      collapseRow: lang === "fr" ? "Réduire la ligne" : lang === "pt-BR" ? "Recolher linha" : "Collapse row",
      showFilterMenu: lang === "fr" ? "Afficher le menu des filtres" : lang === "pt-BR" ? "Mostrar menu de filtros" : "Show filter menu",
      hideFilterMenu: lang === "fr" ? "Masquer le menu des filtres" : lang === "pt-BR" ? "Ocultar menu de filtros" : "Hide filter menu",
      filterOperator: lang === "fr" ? "Opérateur de filtre" : lang === "pt-BR" ? "Operador de filtro" : "Filter operator",
      filterConstraint: lang === "fr" ? "Contrainte de filtre" : lang === "pt-BR" ? "Restrição de filtro" : "Filter constraint",
      editRow: lang === "fr" ? "Modifier la ligne" : lang === "pt-BR" ? "Editar linha" : "Edit row",
      saveEdit: lang === "fr" ? "Enregistrer la modification" : lang === "pt-BR" ? "Salvar edição" : "Save edit",
      cancelEdit: lang === "fr" ? "Annuler la modification" : lang === "pt-BR" ? "Cancelar edição" : "Cancel edit",
      listView: lang === "fr" ? "Vue liste" : lang === "pt-BR" ? "Visualização em lista" : "List view",
      gridView: lang === "fr" ? "Vue grille" : lang === "pt-BR" ? "Visualização em grade" : "Grid view",
      slide: lang === "fr" ? "Diapositive" : lang === "pt-BR" ? "Slide" : "Slide",
      slideNumber: lang === "fr" ? "Diapositive {slideNumber}" : lang === "pt-BR" ? "Slide {slideNumber}" : "Slide {slideNumber}",
      zoomImage: lang === "fr" ? "Agrandir l'image" : lang === "pt-BR" ? "Ampliar imagem" : "Zoom image",
    },
  };
}

export function applyPrimeLocale(lang: Lang): void {
  addLocale(lang, bundle(lang));
  setPrimeLocale(lang);
}
